#!/usr/bin/env node
import sade from 'sade';
import { initCommand } from './commands/init.js';
import { captureCommand } from './commands/capture.js';
import { diffCommand } from './commands/diff.js';
import { openapiCommand } from './commands/openapi.js';

const prog = sade('storage-spec');

prog
  .version('1.0.0');

prog
  .command('init')
  .describe('Get or update the baseline S3 Smithy model')
  .option('--source', 'Path to the tiers markdown file')
  .option('--output', 'Path to output the filtered Smithy AST JSON', 'specs/s3-baseline.json')
  .action(initCommand);

prog
  .command('capture')
  .describe('Intercept HTTP traffic and generate a compatible S3 Smithy profile')
  .option('--target', 'Target URL of the S3 compatible API')
  .option('--test-command', 'Test command to execute')
  .action(captureCommand);

prog
  .command('diff')
  .describe('Compare the baseline and compatible Smithy ASTs to output a markdown compatibility report')
  .option('--baseline', 'Path to the baseline Smithy model JSON')
  .option('--compatible', 'Path to the compatible Smithy model JSON')
  .option('--output', 'Path to output the Markdown report')
  .action(diffCommand);

prog
  .command('openapi')
  .describe('Export a Smithy AST profile to an OpenAPI 3.1 YAML file')
  .option('--input', 'Path to the Smithy AST JSON', 'specs/s3-baseline.json')
  .option('--output', 'Path to output the OpenAPI YAML', 'specs/openapi.yaml')
  .action(openapiCommand);

prog.parse(process.argv);
