import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "public");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "vendor/pdf"), { recursive: true });
await mkdir(join(output, "vendor/mammoth"), { recursive: true });

for (const filename of ["index.html", "styles.css", "app.js"]) {
  await cp(join(root, filename), join(output, filename));
}

await cp(join(root, "media"), join(output, "media"), { recursive: true });
await cp(
  join(root, "node_modules/pdfjs-dist/build/pdf.min.mjs"),
  join(output, "vendor/pdf/pdf.min.mjs")
);
await cp(
  join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  join(output, "vendor/pdf/pdf.worker.min.mjs")
);
await cp(
  join(root, "node_modules/mammoth/mammoth.browser.min.js"),
  join(output, "vendor/mammoth/mammoth.browser.min.js")
);

console.log("Vercel 静态资源已生成：public/");
