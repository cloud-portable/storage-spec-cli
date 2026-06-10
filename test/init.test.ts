import { describe, it, expect } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('init command', () => {
  it('should fetch and correctly filter the baseline model from default s3-baseline.md', async () => {
    // Run the command
    await initCommand({});

    // Verify output files exist
    const specsDir = path.join(process.cwd(), 'specs');
    const rawPath = path.join(specsDir, 's3-2006-03-01.json');
    const baselinePath = path.join(specsDir, 's3-baseline.json');

    const rawExists = await fs.stat(rawPath).catch(() => null);
    const baselineExists = await fs.stat(baselinePath).catch(() => null);

    expect(rawExists).toBeTruthy();
    expect(baselineExists).toBeTruthy();

    const baselineJson = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const operations = baselineJson.shapes['com.amazonaws.s3#AmazonS3'].operations;

    expect(operations.length).toBeGreaterThan(0);
    expect(operations.length).toBeLessThan(50);

    const hasCreateBucket = operations.some(
      (op: any) => op.target === 'com.amazonaws.s3#CreateBucket'
    );
    expect(hasCreateBucket).toBe(true);
    
    // Test that an operation not in the baseline is removed (e.g. AccelerateConfiguration)
    const hasAccelerate = operations.some(
      (op: any) => op.target === 'com.amazonaws.s3#PutBucketAccelerateConfiguration'
    );
    expect(hasAccelerate).toBe(false);
  }, 30000); // 30s timeout

  it('should fetch and correctly filter the baseline model from an external tiers.md', async () => {
    // Run the command pointing to the newly created storage/tiers.md
    await initCommand({
      source: '../storage/tiers.md'
    });

    const specsDir = path.join(process.cwd(), 'specs');
    const baselinePath = path.join(specsDir, 's3-baseline.json');
    const baselineJson = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const operations = baselineJson.shapes['com.amazonaws.s3#AmazonS3'].operations;

    // Check that we filtered down to exactly the Tier 1 operations
    // (There should be exactly 11 operations)
    expect(operations.length).toBe(11);

    const expectedOps = [
      'com.amazonaws.s3#CreateBucket',
      'com.amazonaws.s3#DeleteBucket',
      'com.amazonaws.s3#HeadBucket',
      'com.amazonaws.s3#ListBuckets',
      'com.amazonaws.s3#ListObjectsV2',
      'com.amazonaws.s3#PutObject',
      'com.amazonaws.s3#GetObject',
      'com.amazonaws.s3#HeadObject',
      'com.amazonaws.s3#DeleteObject',
      'com.amazonaws.s3#DeleteObjects',
      'com.amazonaws.s3#CopyObject'
    ];

    expectedOps.forEach(op => {
      const hasOp = operations.some((o: any) => o.target === op);
      expect(hasOp).toBe(true);
    });

    // Tier 2 operations should NOT be present (e.g. CreateMultipartUpload)
    const hasMultipart = operations.some(
      (op: any) => op.target === 'com.amazonaws.s3#CreateMultipartUpload'
    );
    expect(hasMultipart).toBe(false);
  }, 30000);
});

