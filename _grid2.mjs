import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";
const [src, out] = [process.argv[2], process.argv[3]];
const pdf = await PDFDocument.load(readFileSync(src), { ignoreEncryption: true });
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.getPages()[0];
const { width, height } = page.getSize();
const STEP = 100;
for (let x = 0; x <= width; x += STEP) {
  page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: x % 500 === 0 ? 2 : 0.5, color: rgb(1, 0, 0), opacity: x % 500 === 0 ? 0.55 : 0.25 });
  page.drawText(String(x), { x: x + 2, y: height - 22, size: 20, font, color: rgb(1, 0, 0) });
}
for (let yTop = 0; yTop <= height; yTop += STEP) {
  const y = height - yTop;
  page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: yTop % 500 === 0 ? 2 : 0.5, color: rgb(0, 0, 1), opacity: yTop % 500 === 0 ? 0.55 : 0.25 });
  page.drawText(String(yTop), { x: 4, y: y - 20, size: 20, font, color: rgb(0, 0, 1) });
}
writeFileSync(out, await pdf.save());
console.log("grid " + width.toFixed(0) + "x" + height.toFixed(0) + " -> " + out);
