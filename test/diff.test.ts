import { describe, it, expect } from 'vitest';
import { bootstrapCommand } from '../src/commands/bootstrap.js';
import { diffCommand } from '../src/commands/diff.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

describe('diff command', () => {
    it('should generate a markdown compatibility report', async () => {
        const specsDir = path.join(process.cwd(), 'specs');
        const reportPath = path.join(process.cwd(), 'test-report.md');
        const barePath = path.join(specsDir, 'tier-1.smithy.bare.json');
        
        // Ensure baseline exists
        await bootstrapCommand({
            source: './test/fixtures/test-tier.yaml',
            output: barePath
        });

        if (existsSync(reportPath)) {
            await fs.rm(reportPath);
        }

        await diffCommand(
            barePath,
            path.join(process.cwd(), 'test', 'fixtures', 'compatible-s3.json'),
            { output: reportPath }
        );

        const reportExists = await fs.stat(reportPath).catch(() => null);
        expect(reportExists).toBeTruthy();

        const reportContent = await fs.readFile(reportPath, 'utf8');
        expect(reportContent).toContain('# S3 API Compatibility Report');
        expect(reportContent).toContain('## ✅ Supported Operations');
        
        // PutObject is recorded in compatible-s3.json and is in the baseline
        expect(reportContent).toContain('- `PutObject`');
        
        // GetObject is in the baseline but missing from compatible-s3.json
        expect(reportContent).toContain('## ❌ Missing Operations');
        expect(reportContent).toContain('- `GetObject`');

        await fs.rm(reportPath, { force: true });
    });
});
