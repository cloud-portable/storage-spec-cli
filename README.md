# Storage Spec CLI

`storage-spec` is a Node.js CLI tool designed to generate reproducible, native Smithy AST profiles and OpenAPI specifications summarizing the compatibility level of generic S3-compatible storage implementations.

## The Spec Lifecycle

The tool divides the specification lifecycle into four simple stages:

1. **`bootstrap`**: Extract a filtered Smithy AST from the canonical AWS S3 spec.
2. **`compile`**: Combine the Smithy AST with Markdown docs to output documented Smithy AST and OpenAPI spec files.
3. **`test`**: Runs containerized conformance tests against a S3-compatible target, outputting a standard JUnit XML report and execution metadata.
4. **`diff`**: Compares any two Smithy AST profiles (e.g. AWS vs Portable Spec, or Portable Spec vs Provider Spec) to generate markdown compatibility/drift reports.

## Installation

### Local Development (Pre-publish)
If you are developing locally with this and the `storage` specifications repository side-by-side, you can link the binary globally:
```bash
# In the storage-spec-cli directory:
npm install
npm run build
npm link
```
This registers the global `storage-spec` command on your machine. You can then run it from any directory (including the `storage` sibling repo) using `storage-spec <command>`.

## Usage

Below, we assume the command `storage-spec` has been linked locally.

### 1. `bootstrap`
Downloads and caches the official canonical S3 Smithy Model (`s3-2006-03-01.json`). It reads a structured YAML manifest (e.g., `tier-1.yaml`) to filter the shapes down to the allowed operations, strips all documentation/examples traits, and outputs a bare baseline model. Optionally extracts initial sanitized markdown documentation for each operation.

```bash
# Bootstrap using the default tier-1.yaml manifest
storage-spec bootstrap

# Bootstrap and extract initial sanitized markdown docs
storage-spec bootstrap --source ../storage/tier-1.yaml --output ../storage/tier-1.smithy.bare.json --extract-docs ../storage/operations
```
*Outputs: `tier-1.smithy.bare.json` (and initial `.md` templates)*

### 2. `compile`
Merges the barebones baseline Smithy AST with curated markdown documentation overrides and generates both fully-documented Smithy AST and OpenAPI 3.1 specifications.
```bash
storage-spec compile --input ../storage/tier-1.smithy.bare.json --docs ../storage/operations --output-smithy ../storage/tier-1.smithy.json --output-openapi ../storage/tier-1.openapi.yaml
```
*Outputs: `tier-1.smithy.json`, `tier-1.openapi.yaml`*

### 3. `test`
Runs containerized S3 conformance tests (based on Ceph s3-tests) against a target S3-compatible service using a Docker runner.
```bash
storage-spec test --target http://localhost:3900 \
  --access-key <main_access_key> \
  --secret-key <main_secret_key> \
  --output ../storage/docs/garage-report
```
*Outputs: `report.xml` and `metadata.json`*

### 4. `diff`
Performs an operation-level comparison between two Smithy AST profiles and outputs a compatibility report.
```bash
# Compare standard portable spec against MinIO active profile
storage-spec diff --baseline ../storage/tier-1.smithy.json --compatible test/fixtures/compatible-s3.json --output report.md
```
*Outputs: `report.md`*
