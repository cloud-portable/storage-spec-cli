#!/usr/bin/env node
import sade from 'sade';
import { bootstrapCommand } from './commands/bootstrap.js';
import { compileCommand } from './commands/compile.js';
import { testCommand } from './commands/test.js';
import { reportCommand } from './commands/report.js';
import { diffCommand } from './commands/diff.js';
import { fetchAwsDocsCommand } from './commands/fetch-aws-docs.js';

const prog = sade('storage-spec');

prog
  .version('1.0.0');

prog
  .command('bootstrap')
  .describe('Fetch the raw S3 model, filter operations from YAML manifest, and output a bare Smithy AST')
  .option('--source', 'Path to the tier definition YAML file', '../storage/tier-1.yaml')
  .option('--output', 'Path to output the filtered bare Smithy AST JSON', 'specs/tier-1.smithy.bare.json')
  .option('--extract-docs', 'Directory to extract initial sanitized markdown docs (optional)')
  .option('--keep-docs', 'Keep original AWS documentation and examples in the output AST', false)
  .option('--force', 'Overwrite existing extracted markdown files', false)
  .action(bootstrapCommand);
 
prog
  .command('compile')
  .describe('Merge bare Smithy AST with markdown docs to output documented Smithy and OpenAPI specs')
  .option('--input', 'Path to the bare Smithy AST JSON', 'specs/tier-1.smithy.bare.json')
  .option('--output-smithy', 'Path to output the documented Smithy AST JSON', '../storage/tier-1.smithy.json')
  .option('--output-openapi', 'Path to output the documented OpenAPI YAML', '../storage/tier-1.openapi.yaml')
  .option('--docs', 'Directory containing markdown documentation overrides', '../storage/operations')
  .action(compileCommand);

prog
  .command('test')
  .describe('Run containerized conformance tests against a target S3 compatible API')
  .option('--target', 'Target URL of the S3 compatible API')
  .option('--access-key', 'Main AWS access key ID')
  .option('--secret-key', 'Main AWS secret access key')
  .option('--alt-access-key', 'Alternative AWS access key ID')
  .option('--alt-secret-key', 'Alternative AWS secret access key')
  .option('--tenant-access-key', 'Tenant AWS access key ID')
  .option('--tenant-secret-key', 'Tenant AWS secret access key')
  .option('--output', 'Directory to write JUnit report.xml and metadata.json', '../storage/docs')
  .option('--target-engine', 'Name of the target engine', 'Garage')
  .option('--tier-manifest', 'Path to the tier definition YAML file', '../storage/tier-1.yaml')
  .action(testCommand);

prog
  .command('report')
  .describe('Compile a dynamic HTML conformance report from JUnit XML and metadata')
  .option('--junit', 'Path to the input JUnit report.xml')
  .option('--metadata', 'Path to the input metadata.json')
  .option('--output', 'Path to the output HTML report file')
  .option('--template', 'Path to the HTML report template')
  .option('--run-history', 'Comma-separated list of history versions (optional)')
  .option('--see-also', 'Comma-separated list of other targets and report links, e.g. "LocalStack=mock-report-localstack.html,MinIO=#" (optional)')
  .action(reportCommand);

prog
  .command('diff <base> <compare>')
  .describe('Compare baseline and compatible Smithy ASTs to output a markdown compatibility report')
  .option('--output', 'Path to output the Markdown report', 'Compatibility-Report.md')
  .action(diffCommand);

prog
  .command('fetch-aws-docs')
  .describe('Fetch the original AWS markdown formatted documentation for all operations in the tier-1 YAML')
  .option('--source', 'Path to the tier definition YAML file', '../storage/tier-1.yaml')
  .option('--output-dir', 'Directory to save the fetched markdown files', '../storage/operations')
  .action(fetchAwsDocsCommand);

prog.parse(process.argv);
