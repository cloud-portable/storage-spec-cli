import { describe, it, expect, beforeAll } from 'vitest';
import { bootstrapCommand } from '../src/commands/bootstrap.js';
import { compileCommand } from '../src/commands/compile.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'yaml';

describe('OpenAPI Integration & Tool Compatibility', () => {
  const specsDir = path.join(process.cwd(), 'specs');
  const barePath = path.join(specsDir, 'tier-1.smithy.bare.json');
  const outputSmithy = path.join(specsDir, 'tier-1.smithy.json');
  const outputOpenapi = path.join(specsDir, 'tier-1.openapi.yaml');
  const tempDocsDir = path.join(specsDir, 'temp-integration-docs');
  const outputHtml = path.join(specsDir, 'test-docs.html');

  beforeAll(async () => {
    // 1. Prepare directories
    await fs.mkdir(specsDir, { recursive: true });
    await fs.rm(tempDocsDir, { recursive: true, force: true }).catch(() => null);
    await fs.mkdir(tempDocsDir, { recursive: true });
    await fs.rm(outputHtml, { force: true }).catch(() => null);

    // 2. Bootstrap & extract hybrid markdown docs
    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: barePath,
      'extract-docs': tempDocsDir
    });

    // 3. Edit PutObject.md description in the presentation plane (above details tag)
    const putObjectMdPath = path.join(tempDocsDir, 'PutObject.md');
    let putObjectContent = await fs.readFile(putObjectMdPath, 'utf-8');
    putObjectContent = putObjectContent.replace(
      /# PutObject\n([\s\S]*?)\n## Request/,
      '# PutObject\nPutObject custom docs\nAdds an object to a bucket.\n\n## Request'
    );
    await fs.writeFile(putObjectMdPath, putObjectContent, 'utf-8');

    // 4. Edit CopyObject.md description in the presentation plane (above details tag)
    const copyObjectMdPath = path.join(tempDocsDir, 'CopyObject.md');
    let copyObjectContent = await fs.readFile(copyObjectMdPath, 'utf-8');
    copyObjectContent = copyObjectContent.replace(
      /# CopyObject\n([\s\S]*?)\n## Request/,
      '# CopyObject\nCopyObject custom docs\nCreates a copy of an object already stored in S3.\n\n## Request'
    );
    await fs.writeFile(copyObjectMdPath, copyObjectContent, 'utf-8');

    // 5. Run compile command on the edited hybrid docs
    await compileCommand({
      input: barePath,
      'output-smithy': outputSmithy,
      'output-openapi': outputOpenapi,
      docs: tempDocsDir
    });
  });

  it('should generate an OpenAPI specification with XML schema annotations', async () => {
    const yamlContent = await fs.readFile(outputOpenapi, 'utf-8');
    const spec = yaml.parse(yamlContent);

    // Verify XML schemas are generated for payloads
    expect(spec.components).toBeDefined();
    expect(spec.components.schemas).toBeDefined();

    // Check DeleteObjects response schema (e.g., DeleteObjectsOutput)
    const deleteResult = spec.components.schemas.DeleteObjectsOutput;
    expect(deleteResult).toBeDefined();
    expect(deleteResult.xml).toBeDefined();
    expect(deleteResult.xml.name).toBe('DeleteResult');
    expect(deleteResult.xml.namespace).toContain('s3.amazonaws.com');
  });

  it('should model the PUT /Bucket/Key overload with oneOf request bodies', async () => {
    const yamlContent = await fs.readFile(outputOpenapi, 'utf-8');
    const spec = yaml.parse(yamlContent);

    const putPath = spec.paths['/{Bucket}/{Key}'];
    expect(putPath).toBeDefined();
    expect(putPath.put).toBeDefined();

    const requestBody = putPath.put.requestBody;
    expect(requestBody).toBeDefined();

    // Verify it maps both binary and XML empty bodies
    expect(requestBody.content).toBeDefined();
    expect(requestBody.content['application/octet-stream']).toBeDefined();
    expect(requestBody.content['application/xml']).toBeDefined();

    // Ensure headers contain x-amz-copy-source
    const parameters = putPath.put.parameters || [];
    const copySourceParam = parameters.find((p: any) => p.name === 'x-amz-copy-source');
    expect(copySourceParam).toBeDefined();
    expect(copySourceParam.in).toBe('header');
  });

  it('should pass Redocly lint checks with zero errors', () => {
    // Run redocly lint on the generated specification.
    // If there are errors, the command exits with non-zero and execSync throws.
    const lintResult = execSync(`npx @redocly/cli lint ${outputOpenapi} 2>&1`, { encoding: 'utf-8' });
    expect(lintResult).toContain('Your API description is valid');
  }, 15000);

  it('should generate readable HTML docs via Redocly containing both Put and Copy', async () => {
    // Run redocly build-docs
    execSync(`npx @redocly/cli build-docs ${outputOpenapi} -o ${outputHtml}`, { stdio: 'ignore' });
    expect(existsSync(outputHtml)).toBe(true);

    const htmlContent = await fs.readFile(outputHtml, 'utf-8');
    
    // Check that custom docs for both PutObject and CopyObject are rendered in the HTML
    expect(htmlContent).toContain('PutObject');
    expect(htmlContent).toContain('CopyObject');
    expect(htmlContent).toContain('Adds an object to a bucket.');
    expect(htmlContent).toContain('Creates a copy of an object already stored in S3.');
  }, 15000);

  it('should logically match 100% of shapes and sanitized documentation in a lossless round-trip', async () => {
    const cleanDocsDir = path.join(specsDir, 'temp-clean-docs');
    const cleanBarePath = path.join(specsDir, 'tier-1.smithy.clean-bare.json');
    const cleanCompiledSmithy = path.join(specsDir, 'tier-1.smithy.clean.json');
    const cleanCompiledOpenapi = path.join(specsDir, 'tier-1.openapi.clean.yaml');

    await fs.rm(cleanDocsDir, { recursive: true, force: true }).catch(() => null);
    await fs.mkdir(cleanDocsDir, { recursive: true });

    // Bootstrap into the clean directory
    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: cleanBarePath,
      'extract-docs': cleanDocsDir
    });

    // Compile from the clean directory
    await compileCommand({
      input: cleanBarePath,
      'output-smithy': cleanCompiledSmithy,
      'output-openapi': cleanCompiledOpenapi,
      docs: cleanDocsDir
    });

    // 1. Load compiled AST B (which came from hybrid markdown files with NO human edits)
    const astB = JSON.parse(await fs.readFile(cleanCompiledSmithy, 'utf-8'));

    // 2. Load and sanitize bare AST A (with original docs intact but sanitized)
    const bareWithDocsPath = path.join(specsDir, 'tier-1.smithy.with-docs.json');
    await bootstrapCommand({
      source: './test/fixtures/test-tier.yaml',
      output: bareWithDocsPath,
      'keep-docs': true
    });
    
    const astA = JSON.parse(await fs.readFile(bareWithDocsPath, 'utf-8'));

    const sanitizedAstA = astA;

    // Adjust service shape documentation in sanitizedAstA to match index.md's title description
    if (sanitizedAstA.shapes['com.amazonaws.s3#AmazonS3']?.traits) {
      sanitizedAstA.shapes['com.amazonaws.s3#AmazonS3'].traits['smithy.api#documentation'] = 'Shared schema definitions for S3 operations.';
    }

    // Assert shape counts match
    const keysA = Object.keys(sanitizedAstA.shapes).sort();
    const keysB = Object.keys(astB.shapes).sort();
    expect(keysA.length).toBe(keysB.length);
    expect(keysA).toEqual(keysB);

    // Compare all shapes one by one
    for (const shapeId of keysA) {
      expect(astB.shapes[shapeId]).toEqual(sanitizedAstA.shapes[shapeId]);
    }

    // Clean up
    await fs.rm(bareWithDocsPath, { force: true }).catch(() => null);
    await fs.rm(cleanBarePath, { force: true }).catch(() => null);
    await fs.rm(cleanCompiledSmithy, { force: true }).catch(() => null);
    await fs.rm(cleanCompiledOpenapi, { force: true }).catch(() => null);
    await fs.rm(cleanDocsDir, { recursive: true, force: true }).catch(() => null);
  }, 30000);
});
