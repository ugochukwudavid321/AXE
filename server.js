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

// 1. SUPABASE SERVER INITIALIZATION 
// (Requires dependency: npm install @supabase/supabase-js)
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL || 'SUPABASE_URL_PLACEHOLDER';
// SECURITY REQUIREMENT: Provide this securely in your .env file
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'SUPABASE_SERVICE_ROLE_KEY_PLACEHOLDER';

// Create a server-side client bypassing RLS specifically for verified operations
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Initialize the Express application
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
// Enable CORS for all origins
app.use(cors());
// Serve static files from the 'public' directory
app.use(express.static('public'));

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const tmpDir = path.join(__dirname, 'tmp');
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
                if (fileExt === '.jpg' || fileExt === '.jpeg') {
                    compressedBuffer = await sharp(buffer).jpeg({ quality: sharpQuality }).toBuffer();
                } else if (fileExt === '.png') {
                    compressedBuffer = await sharp(buffer).png({ quality: sharpQuality }).toBuffer();
                } else {
                    compressedBuffer = buffer;
                }
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
            
            await new Promise((resolve, reject) => {
                execFile('gs', gsArgs, (error, stdout, stderr) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
            job.logs.push("Compression complete.");
        }
        
        // Finalize standard execution status
        const stats = await fs.promises.stat(job.outputPath);
        job.compressedSize = stats.size;
        
        const reductionPercentage = (((job.originalSize - job.compressedSize) / job.originalSize) * 100).toFixed(2);
        
        job.logs.push(`Compressed size: ${bytesToMB(job.compressedSize)} MB`);
        job.logs.push(`Size reduced by ${reductionPercentage}%`);
        
        // ==========================================================
        // SECURE CLOUD UPLOAD & DATABASE ENTRY 
        // ==========================================================
        if (job.userId) {
            try {
                job.logs.push("Pushing artifact to secure 30-day cloud bucket...");
                
                const fileBuffer = await fs.promises.readFile(job.outputPath);
                const storagePath = `${job.userId}/${jobId}-${job.outputFilename}`;
                const contentType = ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                
                // 1. Upload to Supabase Storage
                const { error: uploadError } = await supabase.storage
                    .from('compressed-files')
                    .upload(storagePath, fileBuffer, {
                        contentType: contentType,
                        upsert: false
                    });
                    
                if (uploadError) throw uploadError;
                
                job.logs.push("Registering cloud metadata to database...");
                const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
                
                // 2. Insert DB row
                // FIX: user_id must be set explicitly here. The `auth.uid()` column default
                // only evaluates when a request carries an end-user JWT — this server uses the
                // service_role key (no attached user), so auth.uid() would be NULL and the
                // insert would fail the NOT NULL constraint on user_id every time.
                // job.userId is safe to use here: it was set once, server-side, only after
                // independently verifying the Bearer token in the /compress route below —
                // it is never taken directly from client input.
                const { error: dbError } = await supabase
                    .from('files')
                    .insert({
                        user_id: job.userId,
                        filename: file.originalname,
                        storage_path: storagePath,
                        original_size: job.originalSize,
                        compressed_size: job.compressedSize,
                        expires_at: expiresAt
                    });
                    
                if (dbError) throw dbError;
                
                job.logs.push("30-Day Retention active for your account.");
                
            } catch (storageErr) {
                console.error(`Storage/DB error for job ${jobId}:`, storageErr);
                job.logs.push("Warning: Secure cloud sync failed. File is available locally.");
            }
        } else {
            job.logs.push("Anonymous Mode: Ephemeral storage bypass active.");
        }

        job.logs.push("File ready for download.");
        job.status = 'done';
        
    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        job.status = 'error';
        job.error = error.message || 'An unknown error occurred during compression.';
    } finally {
        // Clean up input file immediately after processing
        fs.unlink(inputFilePath, () => {});
    }
};

// POST route to initialize the compression job
// Refactored to `async` for secure session token parsing
app.post('/compress', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Bad Request: No file uploaded.' });
    }
    const parsedPath = path.parse(req.file.originalname);
    const ext = parsedPath.ext.toLowerCase();
    
    if (ext !== '.docx' && ext !== '.pdf') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX file.' });
    }
    
    // ==========================================================
    // SECURE TOKEN VERIFICATION (TRUST NOTHING FROM CLIENT)
    // ==========================================================
    let verifiedUserId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        
        // Independently verify token legitimacy on the server
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (user && !error) {
            verifiedUserId = user.id; // Only truth mechanism used
        }
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
        createdAt: Date.now(),
        userId: verifiedUserId // Save securely for processor context
    };
    jobs.set(jobId, job);
    
    job.logs.push(`Received: ${req.file.originalname}`);
    job.logs.push(`Original size: ${bytesToMB(job.originalSize)} MB`);
    job.logs.push("Starting compression pipeline...");
    
    // Start background processing without blocking the response
    processFile(jobId, req.file, req.body);
    
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
