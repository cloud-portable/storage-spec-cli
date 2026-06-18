import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function diffCommand(base: string, compare: string, opts: any) {
    if (!base || !compare) {
        throw new Error('Usage: storage-spec diff <base spec> <spec to diff>');
    }
    const baselinePath = path.resolve(process.cwd(), base);
    const compatiblePath = path.resolve(process.cwd(), compare);
    const outputPath = opts.output ? path.resolve(process.cwd(), opts.output) : path.resolve(process.cwd(), 'Compatibility-Report.md');

    if (!existsSync(baselinePath)) {
        throw new Error(`Baseline model not found at ${baselinePath}`);
    }
    if (!existsSync(compatiblePath)) {
        throw new Error(`Compatible model not found at ${compatiblePath}`);
    }

    const baselineAst = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const compatibleAst = JSON.parse(await fs.readFile(compatiblePath, 'utf8'));

    const baselineOps = baselineAst.shapes['com.amazonaws.s3#AmazonS3']?.operations || [];
    const compatibleOps = compatibleAst.shapes['com.amazonaws.s3#AmazonS3']?.operations || [];

    const baselineOpNames = new Set<string>(baselineOps.map((op: any) => op.target.split('#')[1]));
    const compatibleOpNames = new Set<string>(compatibleOps.map((op: any) => op.target.split('#')[1]));

    const supported: string[] = [];
    const missing: string[] = [];

    for (const op of Array.from(baselineOpNames).sort()) {
        if (compatibleOpNames.has(op)) {
            supported.push(op);
        } else {
            missing.push(op);
        }
    }

    const total = baselineOpNames.size;
    const supportPct = total > 0 ? Math.round((supported.length / total) * 100) : 0;

    let md = `# S3 API Compatibility Report\n\n`;
    md += `**Overall Compatibility:** ${supported.length} / ${total} operations (${supportPct}%)\n\n`;

    md += `## ✅ Supported Operations\n`;
    if (supported.length === 0) {
        md += `*None*\n`;
    } else {
        supported.forEach(op => {
            md += `- \`${op}\`\n`;
        });
    }

    md += `\n## ❌ Missing Operations\n`;
    if (missing.length === 0) {
        md += `*None*\n`;
    } else {
        missing.forEach(op => {
            md += `- \`${op}\`\n`;
        });
    }

    await fs.writeFile(outputPath, md, 'utf-8');
    console.log(`Report generated successfully at ${outputPath}`);
}
