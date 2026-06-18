import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import yaml from 'yaml';

const OPERATION_FILTERS: Record<string, string> = {
  CreateBucket: 'test_bucket_create',
  HeadBucket: 'test_bucket_head',
  DeleteBucket: 'test_bucket_delete',
  PutObject: 'test_object_write or test_object_put',
  HeadObject: 'test_object_head',
  GetObject: 'test_object_read or test_object_get',
  DeleteObject: 'test_object_delete',
  ListObjectsV2: 'test_bucket_listv2',
  ListBuckets: 'test_buckets_create_then_list or test_list_buckets',
  CopyObject: 'test_object_copy',
  DeleteObjects: 'test_multi_object_delete or test_multi_objectv2_delete'
};

function runCmd(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function testCommand(opts: any) {
  const targetUrlStr = opts.target;
  if (!targetUrlStr) {
    throw new Error('--target is required (e.g. --target http://localhost:3900)');
  }

  const manifestPath = path.resolve(process.cwd(), opts['tier-manifest'] || '../storage/tier-1.yaml');
  if (!existsSync(manifestPath)) {
    throw new Error(`Tier manifest not found at ${manifestPath}`);
  }

  const outputDir = path.resolve(process.cwd(), opts.output || '../storage/docs');
  await fs.mkdir(outputDir, { recursive: true });

  // Read tier-1 manifest
  const manifestContent = await fs.readFile(manifestPath, 'utf8');
  const manifest = yaml.parse(manifestContent);
  const operations = manifest.operations || [];

  console.log(`Loaded ${operations.length} operations from manifest.`);

  // Map operations to pytest filters
  const filters: string[] = [];
  for (const op of operations) {
    const filter = OPERATION_FILTERS[op.name];
    if (filter) {
      filters.push(`(${filter})`);
    } else {
      console.warn(`Warning: No pytest filter mapped for operation ${op.name}`);
    }
  }

  if (filters.length === 0) {
    throw new Error('No pytest filters mapped for any operations in manifest.');
  }

  const combinedFilter = filters.join(' or ');
  console.log(`Combined pytest filter: ${combinedFilter}`);

  // Parse S3 Target URL
  const targetUrl = new URL(targetUrlStr);
  let s3Host = targetUrl.hostname;
  const s3Port = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
  const s3IsSecure = targetUrl.protocol === 'https:' ? 'True' : 'False';

  // If localhost, point to host.docker.internal to access host services from container
  if (s3Host === 'localhost' || s3Host === '127.0.0.1') {
    s3Host = 'host.docker.internal';
  }

  const mainAccessKey = opts['access-key'] || 'main_access_key';
  const mainSecretKey = opts['secret-key'] || 'main_secret_key';
  const altAccessKey = opts['alt-access-key'] || 'alt_access_key';
  const altSecretKey = opts['alt-secret-key'] || 'alt_secret_key';
  const tenantAccessKey = opts['tenant-access-key'] || 'tenant_access_key';
  const tenantSecretKey = opts['tenant-secret-key'] || 'tenant_secret_key';
  const targetEngine = opts['target-engine'] || 'Garage';

  // Get current repo git commit hash
  let specVersionCommit = 'unknown';
  try {
    specVersionCommit = await runCmd('git rev-parse HEAD');
  } catch (err) {
    console.warn('Could not determine git commit hash:', err instanceof Error ? err.message : err);
  }

  console.log(`Running containerized tests against ${targetUrlStr}...`);

  // Run the docker command
  const dockerCmd = [
    'docker',
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    `-v "${outputDir}":/output`,
    `-e S3_HOST=${s3Host}`,
    `-e S3_PORT=${s3Port}`,
    `-e S3_IS_SECURE=${s3IsSecure}`,
    `-e AWS_ACCESS_KEY_ID=${mainAccessKey}`,
    `-e AWS_SECRET_ACCESS_KEY=${mainSecretKey}`,
    `-e AWS_ACCESS_KEY_ID_ALT=${altAccessKey}`,
    `-e AWS_SECRET_ACCESS_KEY_ALT=${altSecretKey}`,
    `-e AWS_ACCESS_KEY_ID_TENANT=${tenantAccessKey}`,
    `-e AWS_SECRET_ACCESS_KEY_TENANT=${tenantSecretKey}`,
    'conformance-s3-tests-runner',
    `-k "${combinedFilter}"`,
    '-m "not fails_on_aws"'
  ].join(' ');

  console.log(`Executing: ${dockerCmd}`);

  try {
    await runCmd(dockerCmd);
    console.log('Test execution finished successfully.');
  } catch (error: any) {
    // pytest returns exit code 1 if tests fail, which is expected. We still want to write metadata.json.
    console.log('Test execution completed (some tests may have failed).');
  }

  // Write metadata.json
  const metadata = {
    targetEngine,
    targetUrl: targetUrlStr,
    tier: manifest.name || 'Tier 1 (Core)',
    testSuiteSource: 'Ceph s3-tests',
    testSuiteCommit: '5522d1c351f75bc00ae0f64f742f3f095f5939d9',
    specVersionCommit,
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`
  };

  const metadataPath = path.join(outputDir, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`Wrote metadata file to ${metadataPath}`);
}
