const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { transcribeAudio, readDocument } = require('./order-intelligence');

const testDir = path.join(__dirname, 'data', 'test-artifacts');
fs.mkdirSync(testDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createSamplePdf(filePath, text) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);
    doc.fontSize(14).text(text);
    doc.end();
  });
}

async function createSamplePng(filePath, text) {
  const svg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="60" y="180" font-size="52" font-family="Arial" fill="black">${text}</text>
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function main() {
  const audioPath = '/root/.openclaw/media/inbound/9e51bcb9-84b5-463e-a59c-4c47dda6b671.ogg';
  const txtPath = path.join(testDir, 'sample-order.txt');
  const pdfPath = path.join(testDir, 'sample-order.pdf');
  const pngPath = path.join(testDir, 'sample-order.png');

  fs.writeFileSync(txtPath, 'Customer: Test Customer\nAmount: ₪250\nNext step: Confirm the order details\n');
  await createSamplePdf(pdfPath, 'Customer: PDF Customer\nAmount: $99\nNext step: Review the attached order');
  await createSamplePng(pngPath, 'ORDER TEST 250');

  const transcription = await transcribeAudio(audioPath, { language: 'he' });
  assert(transcription.text.length > 0, 'audio transcription returned empty text');

  const txtResult = await readDocument(txtPath);
  assert(txtResult.text.includes('Test Customer'), 'plain text reader did not return expected content');

  const pdfResult = await readDocument(pdfPath);
  assert(pdfResult.text.includes('PDF Customer'), 'pdf reader did not return expected content');

  const imageResult = await readDocument(pngPath, { mediaType: 'image/png' });
  assert(imageResult.text.length > 0, 'image reader returned empty text');

  console.log(JSON.stringify({
    ok: true,
    audio: transcription.text,
    text: txtResult.text,
    pdf: pdfResult.text,
    image: imageResult.text
  }, null, 2));

  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
