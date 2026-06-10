import { describe, it, expect } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { openapiCommand } from '../src/commands/openapi.js';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('openapi command', () => {
  it('should generate a valid OpenAPI 3.1 YAML file from Smithy baseline', async () => {
    // 1. Initialize the baseline with 11 core operations from storage/tiers.md
    await initCommand({
      source: '../storage/tiers.md'
    });

    const specsDir = path.join(process.cwd(), 'specs');
    const inputPath = path.join(specsDir, 's3-baseline.json');
    const outputPath = path.join(specsDir, 'openapi.yaml');

    // 2. Generate the OpenAPI spec
    await openapiCommand({
      input: inputPath,
      output: outputPath
    });

    // 3. Verify output exists
    const exists = await fs.stat(outputPath).catch(() => null);
    expect(exists).toBeTruthy();

    const yaml = await fs.readFile(outputPath, 'utf8');

    // Check key elements in YAML structure
    expect(yaml).toContain('openapi: 3.1.0');
    expect(yaml).toContain('title: Cloud Portable Storage API');
    
    // Check paths are defined
    expect(yaml).toContain('paths:');
    
    // ListBuckets should be mapped to GET /
    expect(yaml).toContain('  /:');
    expect(yaml).toContain('ListBuckets');

    // CreateBucket, DeleteBucket, HeadBucket, ListObjectsV2, DeleteObjects should be mapped to /{Bucket}
    expect(yaml).toContain('  "/{Bucket}":');
    expect(yaml).toContain('CreateBucket');
    expect(yaml).toContain('DeleteBucket');
    expect(yaml).toContain('HeadBucket');
    expect(yaml).toContain('ListObjectsV2');
    expect(yaml).toContain('DeleteObjects');

    // GetObject, DeleteObject, HeadObject, and PutObject/CopyObject (merged) should be mapped to /{Bucket}/{Key}
    expect(yaml).toContain('  "/{Bucket}/{Key}":');
    expect(yaml).toContain('GetObject');
    expect(yaml).toContain('DeleteObject');
    expect(yaml).toContain('HeadObject');
    
    // Merged CopyObject & PutObject operation
    expect(yaml).toContain('CopyObjectOrPutObject');
  });
});
