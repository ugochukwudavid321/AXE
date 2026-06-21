require('dotenv').config();
// Require necessary modules
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const JSZip = require('jszip');
const sharp = require('sharp');

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
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

// Helper function to handle sending the response, headers, and file cleanup
const sendProcessedFile = (res, inputFilePath, outputFilePath, outputFilename, originalSize) => {
    fs.stat(outputFilePath, (err, stats) => {
        if (err) {
            console.error('Error stating output file:', err);
            fs.unlink(inputFilePath, () => {}); // Cleanup input file
            return res.status(500).json({ error: 'Internal Server Error: Failed to read processed file.' });
        }

        const compressedSize = stats.size;

        // Expose custom headers to the client and set the sizes
        res.set('Access-Control-Expose-Headers', 'X-Original-Size, X-Compressed-Size, content - disposition ' );
        res.set('X-Original-Size', originalSize.toString());
        res.set('X-Compressed-Size', compressedSize.toString());

        // Send the file as a download
        res.download(outputFilePath, outputFilename, (downloadError) => {
            if (downloadError && !res.headersSent) {
                console.error('File download error:', downloadError);
                res.status(500).json({ error: 'Internal Server Error: Failed to send the processed file.' });
            }

            // Clean up: Delete both the original and compressed files from the tmp folder
            fs.unlink(inputFilePath, () => {});
            fs.unlink(outputFilePath, () => {});
        });
    });
};

// POST route to handle file processing based on auto-detected file type
app.post('/convert', upload.single('file'), async (req, res) => {
    // Error handling: Check if a file was actually uploaded
    if (!req.file) {
        return res.status(400).json({ error: 'Bad Request: No file uploaded.' });
    }

    const inputFilePath = req.file.path;
    const originalSize = req.file.size;
    const parsedPath = path.parse(req.file.originalname);
    const ext = parsedPath.ext.toLowerCase();

    // Determine compression level (default to medium if not specified or invalid)
    const validLevels = ['low', 'medium', 'high'];
    const requestedLevel = req.body.compressionLevel;
    const compressionLevel = validLevels.includes(requestedLevel) ? requestedLevel : 'medium';

    // Map compression level to Sharp image quality (used for DOCX images)
    const sharpQualityMap = { low: 80, medium: 60, high: 35 };
    const sharpQuality = sharpQualityMap[compressionLevel];

    // Map compression level to Ghostscript PDF settings preset (used for PDFs)
    const gsSettingsMap = { low: '/printer', medium: '/ebook', high: '/screen' };
    const gsSetting = gsSettingsMap[compressionLevel];

    // Process based on the detected file extension
    if (ext === '.docx') {
        const outputFilename = `${parsedPath.name}-compressed.docx`;
        const outputFilePath = path.join(__dirname, 'tmp', outputFilename);

        try {
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

            // Compress each image using the Sharp library
            for (const { relativePath, file } of mediaFiles) {
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
                } else if (fileExt === '.png') {
                    compressedBuffer = await sharp(buffer)
                        .png({ quality: 60 })
                        .toBuffer();
                } else {
                    // Fallback: skip compression for unrecognized formats, keep original
                    compressedBuffer = buffer;
                }

                // Replace the original file in the zip with the compressed one
                zip.file(`word/media/${relativePath}`, compressedBuffer);
            }

            // Rebuild the zip and save to the output path
            const content = await zip.generateAsync({
                type: "nodebuffer",
                compression: "DEFLATE",
                compressionOptions: { level: 9 }
            });
            await fs.promises.writeFile(outputFilePath, content);

            // Send the result back to the client
            sendProcessedFile(res, inputFilePath, outputFilePath, outputFilename, originalSize);

        } catch (error) {
            console.error('JSZip/Sharp processing error:', error);
            fs.unlink(inputFilePath, () => {}); // Clean up
            return res.status(500).json({ error: 'Internal Server Error: Failed to compress DOCX file.' });
        }

    } else if (ext === '.pdf') {
        const outputFilename = `${parsedPath.name}-compressed.pdf`;
        const outputFilePath = path.join(__dirname, 'tmp', outputFilename);

        // Ghostscript arguments for ebook-level standard compression
        const gsArgs = [
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            `-dPDFSETTINGS=${gsSetting}`,
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            `-sOutputFile=${outputFilePath}`,
            inputFilePath
        ];

        // Run Ghostscript as a child process
        execFile('gs', gsArgs, (error, stdout, stderr) => {
            if (error) {
                console.error('Ghostscript execution error:', error);
                fs.unlink(inputFilePath, () => {}); // Clean up
                return res.status(500).json({ error: 'Internal Server Error: Ghostscript failed to compress the PDF.' });
            }

            // Send the result back to the client
            sendProcessedFile(res, inputFilePath, outputFilePath, outputFilename, originalSize);
        });

    } else {
        // Error handling: Handle unsupported file types
        fs.unlink(inputFilePath, () => {}); // Clean up
        return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX file.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});