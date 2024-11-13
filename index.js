// container/index.js

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

dotenv.config();

const RESOLUTIONS = [
    { name: "360p", width: 480, height: 360, bitrate: "800k" },
    { name: "480p", width: 858, height: 480, bitrate: "1400k" },
    { name: "720p", width: 1280, height: 720, bitrate: "2800k" },
];

const s3Client = new S3Client({
    region: "ap-south-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const BUCKET_NAME = process.env.BUCKET_NAME;
const KEY = process.env.KEY;
const PRODUCTION_BUCKET = "video-transcoding-bucket-production";
async function downloadVideo() {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: KEY,
    });

    const response = await s3Client.send(command);
    if (!response.Body) {
        throw new Error("Failed to download file from S3");
    }

    const originalFilePath = `original-video-${KEY}`;
    // Stream the S3 object to a file
    const writableStream = fs.createWriteStream(originalFilePath);
    await new Promise((resolve, reject) => {
        response.Body.pipe(writableStream)
            .on('finish', resolve)
            .on('error', reject);
    });

    return path.resolve(originalFilePath);
}

async function transcodeToHLS(originalVideoPath) {
    const masterPlaylist = [];
    const promises = RESOLUTIONS.map(async (resolution) => {
        const outputDir = `hls-${resolution.name}-${KEY}`;
        const outputM3U8 = path.join(outputDir, 'index.m3u8');

        // Ensure output directory exists
        await fs.promises.mkdir(outputDir, { recursive: true });

        return new Promise((resolve, reject) => {
            ffmpeg(originalVideoPath)
                .outputOptions([
                    '-c:v libx264',
                    '-c:a aac',
                    `-b:v ${resolution.bitrate}`,
                    '-b:a 128k',
                    `-vf scale=${resolution.width}:${resolution.height}`,
                    '-start_number 0',
                    '-hls_time 10',
                    '-hls_list_size 0',
                    '-f hls'
                ])
                .output(outputM3U8)
                .on('start', (commandLine) => {
                    console.log(`Spawned Ffmpeg with command: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    process.stdout.write(`Transcoding ${resolution.name}: ${progress.percent ? progress.percent.toFixed(2) : '0'}% done\r`);
                })
                .on('end', async () => {
                    try {
                        console.log(`\nHLS transcoding completed for ${resolution.name}`);

                        masterPlaylist.push(`#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(resolution.bitrate) * 1000},RESOLUTION=${resolution.width}x${resolution.height}\n${outputDir}/index.m3u8`);

                        const files = await fs.promises.readdir(outputDir);
                        for (const file of files) {
                            const filePath = path.join(outputDir, file);
                            const fileStream = fs.createReadStream(filePath);

                            const putCommand = new PutObjectCommand({
                                Bucket: PRODUCTION_BUCKET,
                                Key: `${outputDir}/${file}`,
                                Body: fileStream
                            });
                            await s3Client.send(putCommand);
                            console.log(`Uploaded ${file} to S3`);
                        }
                        resolve(outputDir);
                    } catch (error) {
                        reject(error);
                    }
                })
                .on('error', (error, stdout, stderr) => {
                    console.error(`Error transcoding ${resolution.name}:`, error.message);
                    console.error('ffmpeg stdout:', stdout);
                    console.error('ffmpeg stderr:', stderr);
                    reject(error);
                })
                .run();
        });
    });

    await Promise.all(promises);

    const masterPlaylistContent = '#EXTM3U\n' + masterPlaylist.join('\n');
    const masterPlaylistPath = `master-${KEY}.m3u8`;
    fs.writeFileSync(masterPlaylistPath, masterPlaylistContent);

    // Upload master playlist to S3
    const masterPlaylistStream = fs.createReadStream(masterPlaylistPath);
    const putMasterCommand = new PutObjectCommand({
        Bucket: PRODUCTION_BUCKET,
        Key: masterPlaylistPath,
        Body: masterPlaylistStream
    });
    await s3Client.send(putMasterCommand);
    console.log(`Uploaded master playlist to S3: ${masterPlaylistPath}`);
}

async function main() {
    try {
        const originalVideoPath = await downloadVideo();
        await transcodeToHLS(originalVideoPath);
    } catch (error) {
        console.error("An error occurred:", error);
        process.exit(1);
    }
}

main().then(() => {
    console.log("All transcoding jobs completed");
    process.exit(0);
}).catch((error) => {
    console.error("Error in main execution:", error);
    process.exit(1);
});