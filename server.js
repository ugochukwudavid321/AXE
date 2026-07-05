
require('dotenv').config();

// Require necessary modules
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const JSZip = require('jszip');
const MOCK_COMPRESSION = process.env.MOCK_COMPRESSION === 'true';
const sharp = MOCK_COMPRESSION ? null : require('sharp');
const crypto = require('crypto');

// Initialize the Express application
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
// Enable CORS for all origins
app.use(cors());
// Serve static files from the 'public' directory
app.use(express.static('public'));

// Configure Multer for file uploads
// Files are temporarily saved to a local 'tmp' directory with their original filenames
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const tmpDir = path.join(__dirname, 'tmp');
        // Ensure the tmp directory exists
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
        cb(null, tmpDir);
    },
    filename: function (req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${unique}-${file.originalname}`);
}
});
const upload = multer({ storage: storage });

// In-memory job storage
const jobs = new Map();

// Background job cleanup: Runs every 5 minutes, deletes jobs/files older than 30 minutes
setInterval(() => {
    const now = Date.now();
    const expiryTime = 30 * 60 * 1000; // 30 minutes in milliseconds

    for (const [jobId, job] of jobs.entries()) {
        if (now - job.createdAt > expiryTime) {
            // Clean up files if they still exist
            if (job.inputPath) fs.unlink(job.inputPath, () => {});
            if (job.outputPath) fs.unlink(job.outputPath, () => {});
            jobs.delete(jobId);
        }
    }
}, 5 * 60 * 1000);

// Helper function to format bytes to MB
const bytesToMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

// Background processing function
const processFile = async (jobId, file, body) => {
    const job = jobs.get(jobId);
    if (!job) return;

    const inputFilePath = file.path;
    const parsedPath = path.parse(file.originalname);
    const ext = parsedPath.ext.toLowerCase();

    // Determine compression level (default to medium if not specified or invalid)
    const validLevels = ['low', 'medium', 'high'];
    const requestedLevel = body.compressionLevel;
    const compressionLevel = validLevels.includes(requestedLevel) ? requestedLevel : 'medium';

        try {
    if (MOCK_COMPRESSION) {
        job.outputFilename = `${parsedPath.name}-mock-compressed${ext}`;
        job.outputPath = path.join(__dirname, 'tmp', job.outputFilename);

        job.logs.push("MOCK MODE: skipping real compression");
        await new Promise(resolve => setTimeout(resolve, 3000)); // simulate work
        await fs.promises.copyFile(inputFilePath, job.outputPath);

    } else if (ext === '.docx') {
            job.outputFilename = `${parsedPath.name}-compressed.docx`;
            job.outputPath = path.join(__dirname, 'tmp', job.outputFilename);

            const sharpQualityMap = { low: 80, medium: 60, high: 35 };
            const sharpQuality = sharpQualityMap[compressionLevel];

            job.logs.push("Reading DOCX structure...");
            
            // Open the DOCX as a zip archive
            const fileData = await fs.promises.readFile(inputFilePath);
            const zip = await JSZip.loadAsync(fileData);

            // Collect all image files inside the word/media/ folder
            const mediaFiles = [];
            zip.folder("word/media").forEach((relativePath, file) => {
                if (!file.dir) {
                    const fileExt = path.extname(relativePath).toLowerCase();
                    if (['.png', '.jpeg', '.jpg'].includes(fileExt)) {
                        mediaFiles.push({ relativePath, file });
                    }
                }
            });

            job.logs.push(`Found ${mediaFiles.length} image(s) inside document`);

            // Compress each image using the Sharp library
            let imageIndex = 1;
            for (const { relativePath, file } of mediaFiles) {
                job.logs.push(`Compressing image ${imageIndex} of ${mediaFiles.length}...`);
                const buffer = await file.async("nodebuffer");
                const fileExt = path.extname(relativePath).toLowerCase();

                let compressedBuffer;

                // Apply the correct compression method based on the actual image format
                if (fileExt === '.jpg' || fileExt === '.jpeg') {
                    compressedBuffer = await sharp(buffer)
                        .jpeg({ quality: sharpQuality })
                        .toBuffer();
                } else if (fileExt === '.png') {
                    compressedBuffer = await sharp(buffer)
                        .png({ quality: sharpQuality })
                        .toBuffer();
                } else {
                    // Fallback: skip compression for unrecognized formats, keep original
                    compressedBuffer = buffer;
                }

                // Replace the original file in the zip with the compressed one
                zip.file(`word/media/${relativePath}`, compressedBuffer);
                imageIndex++;
            }

            job.logs.push("Rebuilding document archive...");
            
            // Rebuild the zip and save to the output path
            const content = await zip.generateAsync({
                type: "nodebuffer",
                compression: "DEFLATE",
                compressionOptions: { level: 9 }
            });
            await fs.promises.writeFile(job.outputPath, content);

        } else if (ext === '.pdf') {
            job.outputFilename = `${parsedPath.name}-compressed.pdf`;
            job.outputPath = path.join(__dirname, 'tmp', job.outputFilename);

            const gsSettingsMap = { low: '/printer', medium: '/ebook', high: '/screen' };
            const gsSetting = gsSettingsMap[compressionLevel];

            job.logs.push("Initialising Ghostscript engine...");
            job.logs.push(`Applying ${compressionLevel.toUpperCase()} compression profile...`);

            // Ghostscript arguments for selected compression level
            const gsArgs = [
                '-sDEVICE=pdfwrite',
                '-dCompatibilityLevel=1.4',
                `-dPDFSETTINGS=${gsSetting}`,
                '-dNOPAUSE',
                '-dQUIET',
                '-dBATCH',
                `-sOutputFile=${job.outputPath}`,
                inputFilePath
            ];

            // Run Ghostscript as a Promise
            await new Promise((resolve, reject) => {
                execFile('gs', gsArgs, (error, stdout, stderr) => {
                    if (error) reject(error);
                    else resolve();
                });
            });

            job.logs.push("Compression complete.");
        }

        // Finalize success status
        const stats = await fs.promises.stat(job.outputPath);
        job.compressedSize = stats.size;
        
        const reductionPercentage = (((job.originalSize - job.compressedSize) / job.originalSize) * 100).toFixed(2);
        
        job.logs.push(`Compressed size: ${bytesToMB(job.compressedSize)} MB`);
        job.logs.push(`Size reduced by ${reductionPercentage}%`);
        job.logs.push("File ready for download.");
        
        job.status = 'done';

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        job.status = 'error';
        job.error = error.message || 'An unknown error occurred during compression.';
    } finally {
        // Clean up input file immediately after processing (success or failure)
        fs.unlink(inputFilePath, () => {});
    }
};

// POST route to initialize the compression job
app.post('/compress', upload.single('file'), (req, res) => {
    // Error handling: Check if a file was actually uploaded
    if (!req.file) {
        return res.status(400).json({ error: 'Bad Request: No file uploaded.' });
    }

    const parsedPath = path.parse(req.file.originalname);
    const ext = parsedPath.ext.toLowerCase();

    // Reject unsupported file types immediately
    if (ext !== '.docx' && ext !== '.pdf') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX file.' });
    }

    const jobId = crypto.randomUUID();
    
    // Create the job record in memory
    const job = {
        status: 'processing',
        logs: [],
        inputPath: req.file.path,
        outputPath: null,
        outputFilename: null,
        originalSize: req.file.size,
        compressedSize: null,
        error: null,
        createdAt: Date.now()
    };

    jobs.set(jobId, job);

    // Initial logs
    job.logs.push(`Received: ${req.file.originalname}`);
    job.logs.push(`Original size: ${bytesToMB(job.originalSize)} MB`);
    job.logs.push("Starting compression pipeline...");

    // Start background processing without blocking the response
    processFile(jobId, req.file, req.body);

    // Immediately return the Job ID to the client for polling
    res.json({ jobId });
});

// GET route to poll job status
app.get('/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found or expired.' });
    }

    res.json({
        status: job.status,
        logs: job.logs,
        originalSize: job.originalSize,
        compressedSize: job.compressedSize,
        error: job.error
    });
});

// GET route to download the finished file
app.get('/download/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found or expired.' });
    }

    if (job.status !== 'done' || !job.outputPath) {
        return res.status(400).json({ error: 'File is not ready for download.' });
    }

    // Expose custom headers to the client and set the sizes
    res.set('Access-Control-Expose-Headers', 'X-Original-Size, X-Compressed-Size, Content-Disposition');
    res.set('X-Original-Size', job.originalSize.toString());
    res.set('X-Compressed-Size', job.compressedSize.toString());

    // Send the file as a download
    res.download(job.outputPath, job.outputFilename, (downloadError) => {
        if (downloadError && !res.headersSent) {
            console.error(`File download error for job ${jobId}:`, downloadError);
            res.status(500).json({ error: 'Internal Server Error: Failed to send the processed file.' });
        }

        // Clean up output file and remove the job from memory after download
        fs.unlink(job.outputPath, () => {});
        jobs.delete(jobId);
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
