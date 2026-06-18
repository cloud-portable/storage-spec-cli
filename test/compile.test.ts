import { describe, it, expect } from 'vitest';
import { bootstrapCommand } from '../src/commands/bootstrap.js';
import { compileCommand } from '../src/commands/compile.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

describe('compile command', () => {
  it('should generate a documented Smithy AST and OpenAPI YAML by merging custom docs', async () => {
    const specsDir = path.join(process.cwd(), 'specs');
    const barePath = path.join(specsDir, 'tier-1.smithy.bare.json');
    const testDocsDir = path.join(specsDir, 'temp-compile-docs');
    const outputSmithy = path.join(specsDir, 'tier-1.smithy.json');
    const outputOpenapi = path.join(specsDir, 'tier-1.openapi.yaml');

    // 1. Bootstrap the bare AST and extract the initial hybrid markdown files
    await fs.rm(testDocsDir, { recursive: true, force: true }).catch(() => null);
    await fs.mkdir(testDocsDir, { recursive: true });

    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath,
      'extract-docs': testDocsDir
    });
    
    // 2. Edit PutObject.md description in the presentation plane (above details tag)
    const putObjectMdPath = path.join(testDocsDir, 'PutObject.md');
    let putObjectContent = await fs.readFile(putObjectMdPath, 'utf-8');
    putObjectContent = putObjectContent.replace(
      /# PutObject\n([\s\S]*?)\n## Request/,
      '# PutObject\nCustom PutObject description\nThis is a vendor neutral PutObject override.\n\n## Request'
    );
    await fs.writeFile(putObjectMdPath, putObjectContent, 'utf-8');

    // 3. Run the compile command
    await compileCommand({
      input: barePath,
      'output-smithy': outputSmithy,
      'output-openapi': outputOpenapi,
      docs: testDocsDir
    });

    // 4. Verify outputs exist
    expect(existsSync(outputSmithy)).toBe(true);
    expect(existsSync(outputOpenapi)).toBe(true);

    // 5. Verify documented Smithy AST contains our override
    const smithyJson = JSON.parse(await fs.readFile(outputSmithy, 'utf-8'));
    const putObjectShape = smithyJson.shapes['com.amazonaws.s3#PutObject'];
    expect(putObjectShape.traits).toBeDefined();
    expect(putObjectShape.traits['smithy.api#documentation']).toContain(
      'Custom PutObject description\nThis is a vendor neutral PutObject override.'
    );
    expect(putObjectShape.traits['smithy.api#documentation']).not.toContain('[Request](#request)');

    // 6. Verify generated OpenAPI YAML contains our override
    const openapiYaml = await fs.readFile(outputOpenapi, 'utf-8');
    expect(openapiYaml).toContain('openapi: 3.1.0');
    expect(openapiYaml).toContain('Custom PutObject description');
    expect(openapiYaml).toContain('This is a vendor neutral PutObject override.');
    expect(openapiYaml).not.toContain('[Request](#request)');

    // Clean up
    await fs.rm(testDocsDir, { recursive: true, force: true }).catch(() => null);
  });

  it('should dynamically pull schemas if needed and rename ListAllMyBucketsResult to ListBucketsOutput with documentation', async () => {
    const specsDir = path.join(process.cwd(), 'specs');
    const tempYaml = path.join(specsDir, 'temp-list-buckets-tier.yaml');
    const barePath = path.join(specsDir, 'temp-list-buckets.smithy.bare.json');
    const outputSmithy = path.join(specsDir, 'temp-list-buckets.smithy.json');
    const outputOpenapi = path.join(specsDir, 'temp-list-buckets.openapi.yaml');

    // Write a temporary manifest containing ListBuckets
    await fs.writeFile(tempYaml, `
name: "Temp Tier"
description: "Temporary tier definition for testing"
operations:
  - name: ListBuckets
    link: "https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListBuckets.html"
`, 'utf-8');

    // Bootstrap it
    await bootstrapCommand({
      source: tempYaml,
      output: barePath
    });

    // Run compile command
    await compileCommand({
      input: barePath,
      'output-smithy': outputSmithy,
      'output-openapi': outputOpenapi,
      docs: 'none'
    });

    const openapiYaml = await fs.readFile(outputOpenapi, 'utf-8');
    const spec = yaml.parse(openapiYaml);

    // 1. Check ListAllMyBucketsResult is NOT present in schemas
    expect(spec.components.schemas.ListAllMyBucketsResult).toBeUndefined();

    // 2. Check ListBucketsOutput IS present in schemas
    expect(spec.components.schemas.ListBucketsOutput).toBeDefined();

    // 3. Check ListBucketsOutput has correct XML name trait mapping (e.g. ListAllMyBucketsResult)
    expect(spec.components.schemas.ListBucketsOutput.xml).toBeDefined();
    expect(spec.components.schemas.ListBucketsOutput.xml.name).toBe('ListAllMyBucketsResult');

    // 4. Check ListBucketsOutput description and its properties documentation from Smithy
    expect(spec.components.schemas.ListBucketsOutput.properties.Buckets.description).toBe('The list of buckets owned by the requester.');

    // 5. Check ListBuckets response references ListBucketsOutput
    const listBucketsPath = spec.paths['/'];
    expect(listBucketsPath.get.responses['200'].content['application/xml'].schema.$ref).toBe('#/components/schemas/ListBucketsOutput');

    // Clean up
    await fs.rm(tempYaml, { force: true }).catch(() => null);
    await fs.rm(barePath, { force: true }).catch(() => null);
    await fs.rm(outputSmithy, { force: true }).catch(() => null);
    await fs.rm(outputOpenapi, { force: true }).catch(() => null);
  });
});
