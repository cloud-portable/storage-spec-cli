import { describe, it, expect } from 'vitest';
import { diffCommand } from '../src/commands/diff.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

describe('diff command', () => {
    it('should generate a markdown compatibility report', async () => {
        const specsDir = path.join(process.cwd(), 'specs');
        const reportPath = path.join(process.cwd(), 'test-report.md');
        
        if (existsSync(reportPath)) {
            await fs.rm(reportPath);
        }

        await diffCommand({
            baseline: path.join(specsDir, 's3-baseline.json'),
            compatible: path.join(specsDir, 'compatible-s3.json'),
            output: reportPath
        });

        const reportExists = await fs.stat(reportPath).catch(() => null);
        expect(reportExists).toBeTruthy();

        const reportContent = await fs.readFile(reportPath, 'utf8');
        expect(reportContent).toContain('# S3 API Compatibility Report');
        expect(reportContent).toContain('## ✅ Supported Operations');
        
        // From previous tests, we know CreateBucket and PutObject were recorded in compatible-s3.json
        expect(reportContent).toContain('- `CreateBucket`');
        expect(reportContent).toContain('- `PutObject`');
        
        // DeleteBucket should be missing
        expect(reportContent).toContain('## ❌ Missing Operations');
        expect(reportContent).toContain('- `DeleteBucket`');

        await fs.rm(reportPath, { force: true });
    });
});
