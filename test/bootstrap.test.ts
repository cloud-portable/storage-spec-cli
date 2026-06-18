import { describe, it, expect } from 'vitest';
import { bootstrapCommand } from '../src/commands/bootstrap.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

describe('bootstrap command', () => {
  it('should fetch, filter the raw model using tier-1.yaml, and sanitize docs', async () => {
    const specsDir = path.join(process.cwd(), 'specs');
    const rawPath = path.join(specsDir, 's3-2006-03-01.json');
    const barePath = path.join(specsDir, 'tier-1.smithy.bare.json');

    // Run the command
    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath
    });

    // Verify output files exist
    const rawExists = await fs.stat(rawPath).catch(() => null);
    const bareExists = await fs.stat(barePath).catch(() => null);

    expect(rawExists).toBeTruthy();
    expect(bareExists).toBeTruthy();

    const bareJson = JSON.parse(await fs.readFile(barePath, 'utf8'));
    const operations = bareJson.shapes['com.amazonaws.s3#AmazonS3'].operations;

    // Check that we filtered down to exactly the test fixture operations (6 operations)
    expect(operations.length).toBe(6);

    const expectedOps = [
      'com.amazonaws.s3#HeadBucket',
      'com.amazonaws.s3#PutObject',
      'com.amazonaws.s3#GetObject',
      'com.amazonaws.s3#DeleteObject',
      'com.amazonaws.s3#CopyObject',
      'com.amazonaws.s3#DeleteObjects'
    ];

    expectedOps.forEach(op => {
      const hasOp = operations.some((o: any) => o.target === op);
      expect(hasOp).toBe(true);
    });

    // Check that documentation was sanitized and examples stripped from operations
    const putObjectShape = bareJson.shapes['com.amazonaws.s3#PutObject'];
    expect(putObjectShape.traits?.['smithy.api#documentation']).toBeTypeOf('string');
    expect(putObjectShape.traits?.['smithy.api#documentation']).toContain('Amazon S3');
    expect(putObjectShape.traits?.['smithy.api#examples']).toBeUndefined();

    // Check that documentation was sanitized on input/output members
    const putObjectRequest = bareJson.shapes[putObjectShape.input.target];
    if (putObjectRequest && putObjectRequest.members) {
      for (const member of Object.values<any>(putObjectRequest.members)) {
        if (member.traits && member.traits['smithy.api#documentation']) {
          expect(member.traits['smithy.api#documentation']).toBeTypeOf('string');
          expect(member.traits['smithy.api#documentation']).not.toContain('<p>');
        }
      }
    }
  }, 30000); // 30s timeout

  it('should extract doc files when --extract-docs option is specified', async () => {
    const barePath = path.join(process.cwd(), 'specs', 'tier-1.smithy.bare.json');
    const extractDir = path.join(process.cwd(), 'specs', 'temp-docs');

    // Clean temp docs directory
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => null);

    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath,
      'extract-docs': extractDir
    });

    // Verify markdown files are extracted
    const putObjectMdPath = path.join(extractDir, 'PutObject.md');
    expect(existsSync(putObjectMdPath)).toBe(true);

    const mdContent = await fs.readFile(putObjectMdPath, 'utf8');
    expect(mdContent.length).toBeGreaterThan(0);
    // Sanity check that HTML tags are converted/stripped and branding is left intact
    expect(mdContent).not.toContain('<p>');
    expect(mdContent).not.toContain('<code>');
    expect(mdContent).toContain('Amazon S3');

    // Verify details block formatting
    expect(mdContent).toContain('## Smithy Spec\n\n<details>\n\n```json');
    expect(mdContent).not.toContain('<summary>');

    // Write a modification to PutObject.md
    await fs.writeFile(putObjectMdPath, 'Custom Human Doc Content', 'utf-8');

    // Run bootstrap again
    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath,
      'extract-docs': extractDir
    });

    // Verify it didn't overwrite the custom markdown
    const mdContentAfter = await fs.readFile(putObjectMdPath, 'utf8');
    expect(mdContentAfter).toBe('Custom Human Doc Content');

    // Clean up
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => null);
  }, 30000);

  it('should format operations according to spec rules (HTTP request required parameters, XML mocks, unescaped underscores, and preserved links)', async () => {
    const barePath = path.join(process.cwd(), 'specs', 'tier-1.smithy.bare.json');
    const extractDir = path.join(process.cwd(), 'specs', 'temp-bootstrap-test-docs');

    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => null);

    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath,
      'extract-docs': extractDir
    });

    // Verify CopyObject.md formatting
    const copyObjectMdPath = path.join(extractDir, 'CopyObject.md');
    expect(existsSync(copyObjectMdPath)).toBe(true);
    const copyObjectContent = await fs.readFile(copyObjectMdPath, 'utf8');

    // 1. Required Header in HTTP Request Snippet, but NO Host header
    expect(copyObjectContent).toContain('x-amz-copy-source: {CopySource}');
    expect(copyObjectContent).not.toContain('Host:');

    // 2. XML Body Mock Wrapping (CopyObjectResult directly at root, not CopyObjectOutput)
    expect(copyObjectContent).toContain('<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult>');
    expect(copyObjectContent).not.toContain('<CopyObjectOutput>');
    // Verify tab indentation: <CopyObjectResult> is at level 0 (0 tabs), its children are indented with 1 tab (\t)
    expect(copyObjectContent).toContain('\n\t<LastModified>');

    // 3. Preserved Outbound Links
    expect(copyObjectContent).toContain('[Using ACLs](https://docs.aws.amazon.com/AmazonS3/latest/dev/S3_ACLs_UsingACLs.html)');

    // 4. No Escaped Underscores
    expect(copyObjectContent).toContain('READ_ACP');
    expect(copyObjectContent).not.toContain('READ\\_ACP');

    // Verify GetObject.md formatting (should be binary data, not XML)
    const getObjectMdPath = path.join(extractDir, 'GetObject.md');
    expect(existsSync(getObjectMdPath)).toBe(true);
    const getObjectContent = await fs.readFile(getObjectMdPath, 'utf8');

    expect(getObjectContent).toContain('Content-Type: application/octet-stream');
    expect(getObjectContent).toContain('[Binary Data]');
    expect(getObjectContent).not.toContain('<GetObjectOutput>');

    // 5. Error formatting: HTTP code in heading, e.g. for NotFound (defaulted to 404) and EncryptionTypeMismatch
    const headBucketMdPath = path.join(extractDir, 'HeadBucket.md');
    expect(existsSync(headBucketMdPath)).toBe(true);
    const headBucketContent = await fs.readFile(headBucketMdPath, 'utf8');
    expect(headBucketContent).toContain('### `404` `NotFound`');

    const sharedShapesMdPath = path.join(extractDir, 'shared-shapes.md');
    expect(existsSync(sharedShapesMdPath)).toBe(true);
    const sharedShapesContent = await fs.readFile(sharedShapesMdPath, 'utf8');
    expect(sharedShapesContent).toContain('### Schema: `404` `NotFound`');
    expect(sharedShapesContent).toContain('### Schema: `400` `EncryptionTypeMismatch`');
    expect(sharedShapesContent).toContain('### Schema: `Error`');

    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => null);
  }, 30000);
});

