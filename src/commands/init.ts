import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function initCommand(options: any) {
  const modelUrl = 'https://raw.githubusercontent.com/aws/api-models-aws/main/models/s3/service/2006-03-01/s3-2006-03-01.json';
  const specsDir = path.join(process.cwd(), 'specs');
  const cachePath = path.join(specsDir, '.cache.json');
  const rawModelPath = path.join(specsDir, 's3-2006-03-01.json');
  const baselineModelPath = options.output ? path.resolve(process.cwd(), options.output) : path.join(specsDir, 's3-baseline.json');
  const sourcePath = options.source ? path.resolve(process.cwd(), options.source) : path.join(process.cwd(), 's3-baseline.md');

  await fs.mkdir(specsDir, { recursive: true });

  let etag = '';
  if (existsSync(cachePath)) {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    etag = cache.etag || '';
  }

  console.log('Fetching raw Smithy model...');
  const headers = new Headers();
  if (etag) headers.set('If-None-Match', etag);

  const response = await fetch(modelUrl, { headers });

  if (response.status === 304) {
    console.log('Model unchanged (304 Not Modified). Using cached model.');
  } else if (!response.ok) {
    throw new Error(`Failed to fetch model: ${response.statusText}`);
  } else {
    console.log('Downloaded new model. Saving...');
    const data = await response.text();
    await fs.writeFile(rawModelPath, data);
    
    const newEtag = response.headers.get('etag');
    if (newEtag) {
      await fs.writeFile(cachePath, JSON.stringify({ etag: newEtag }));
    }
  }

  console.log(`Reading source file at ${sourcePath}...`);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source file not found at ${sourcePath}`);
  }
  let sourceContent = await fs.readFile(sourcePath, 'utf-8');

  if (sourceContent.includes('## Tier 1') || sourceContent.includes('## Tier 2')) {
    const sections = sourceContent.split(/^##\s+/m);
    const tier1Section = sections.find(sec => /^Tier\s*1/i.test(sec));
    if (!tier1Section) {
      throw new Error(`Could not find 'Tier 1' section in ${sourcePath}`);
    }
    sourceContent = tier1Section;
  }

  const requiredOperations = new Set<string>();
  
  const regex = /^\s*-\s+[`\[]*([A-Za-z0-9]+)/gm;
  let match;
  while ((match = regex.exec(sourceContent)) !== null) {
      if (match[1]) {
          requiredOperations.add(match[1]);
      }
  }
  console.log(`Found ${requiredOperations.size} operations in Tier 1 baseline.`);

  console.log('Filtering Smithy AST operations...');
  const ast = JSON.parse(await fs.readFile(rawModelPath, 'utf-8'));
  
  if (!ast?.shapes || !ast.shapes['com.amazonaws.s3#AmazonS3']?.operations) {
      throw new Error('Could not find com.amazonaws.s3#AmazonS3 operations in the Smithy AST.');
  }

  const originalOperations = ast.shapes['com.amazonaws.s3#AmazonS3'].operations;
  
  const filteredOperations = originalOperations.filter((op: any) => {
    const opName = op.target.split('#')[1];
    return requiredOperations.has(opName);
  });
  
  ast.shapes['com.amazonaws.s3#AmazonS3'].operations = filteredOperations;
  console.log(`Filtered from ${originalOperations.length} to ${filteredOperations.length} operations.`);
  
  await fs.writeFile(baselineModelPath, JSON.stringify(ast, null, 2));
  console.log(`Saved baseline model to ${baselineModelPath}`);
}
