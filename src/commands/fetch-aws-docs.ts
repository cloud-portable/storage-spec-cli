import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';

export async function fetchAwsDocsCommand(options: any) {
  const sourcePath = path.resolve(process.cwd(), options.source || '../storage/tier-1.yaml');
  const outputDir = path.resolve(process.cwd(), options['output-dir'] || '../storage/operations');

  console.log(`Reading tier manifest at ${sourcePath}...`);
  try {
    await fs.access(sourcePath);
  } catch {
    throw new Error(`Source tier manifest file not found at ${sourcePath}`);
  }

  const sourceContent = await fs.readFile(sourcePath, 'utf-8');
  const parsedYaml = yaml.parse(sourceContent);
  
  if (!parsedYaml || !Array.isArray(parsedYaml.operations)) {
    throw new Error(`Invalid tier manifest. Missing 'operations' array in ${sourcePath}`);
  }

  const operations = parsedYaml.operations.map((op: any) => {
    if (typeof op === 'string') return op;
    if (op && typeof op === 'object' && op.name) return op.name;
    throw new Error(`Invalid operation item in tier manifest: ${JSON.stringify(op)}`);
  });

  console.log(`Found ${operations.length} operations. Ensuring output directory exists at ${outputDir}...`);
  await fs.mkdir(outputDir, { recursive: true });

  const limit = 3; // Max concurrent fetches
  const results = { success: 0, failed: 0, skipped: 0 };

  // Helper to fetch an operation's doc
  async function fetchDoc(opName: string) {
    const url = `https://docs.aws.amazon.com/AmazonS3/latest/API/API_${opName}.md`;
    const outputPath = path.join(outputDir, `${opName}-aws.md`);

    console.log(`Fetching AWS docs for ${opName} from ${url}...`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[-] Failed to fetch ${opName}: HTTP ${response.status} ${response.statusText}`);
        results.failed++;
        return;
      }
      
      const content = await response.text();
      await fs.writeFile(outputPath, content, 'utf-8');
      console.log(`[+] Saved ${opName}-aws.md`);
      results.success++;
    } catch (error: any) {
      console.error(`[-] Error fetching ${opName}: ${error.message}`);
      results.failed++;
    }
  }

  // Run with basic concurrency limit
  for (let i = 0; i < operations.length; i += limit) {
    const chunk = operations.slice(i, i + limit);
    await Promise.all(chunk.map((op: string) => fetchDoc(op)));
  }

  console.log(`\nFetch complete! Success: ${results.success}, Failed: ${results.failed}`);
}
