import { describe, it, expect } from 'vitest';
import { captureCommand } from '../src/commands/capture.js';
import http from 'http';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('capture command', () => {
    it('should map HTTP requests and generate compatible Smithy AST', async () => {
        // Create a mock target server that returns 200 OK
        const targetServer = http.createServer((req, res) => {
            // We simulate that the target service supports CreateBucket and PutObject
            res.writeHead(200);
            res.end('OK');
        });

        await new Promise<void>((resolve) => targetServer.listen(9001, () => resolve()));

        const compatiblePath = path.join(process.cwd(), 'specs', 'compatible-s3.json');
        
        // Remove existing compatible file if present
        await fs.rm(compatiblePath, { force: true });

        // Run the capture command
        // The test command simply hits the proxy using curl
        // Proxy runs on 8080 by default in the script.
        const testCmd = `node -e "const http = require('http'); http.request('http://localhost:8080/my-bucket', { method: 'PUT' }, (res) => {
            res.on('data', ()=>{});
            http.request('http://localhost:8080/my-bucket/key123', { method: 'PUT' }, (res2) => {
                res2.on('data', ()=>{});
            }).end();
        }).end();"`;

        await captureCommand({
            target: 'http://localhost:9001',
            _: [testCmd]
        });

        // Verify output compatible-s3.json was created
        const compatibleExists = await fs.stat(compatiblePath).catch(() => null);
        expect(compatibleExists).toBeTruthy();

        const compatibleJson = JSON.parse(await fs.readFile(compatiblePath, 'utf8'));
        const operations = compatibleJson.shapes['com.amazonaws.s3#AmazonS3'].operations;

        // We expect CreateBucket (PUT /bucket) and PutObject (PUT /bucket/key)
        const hasCreateBucket = operations.some((op: any) => op.target === 'com.amazonaws.s3#CreateBucket');
        const hasPutObject = operations.some((op: any) => op.target === 'com.amazonaws.s3#PutObject');

        expect(hasCreateBucket).toBe(true);
        expect(hasPutObject).toBe(true);

        targetServer.close();
    }, 30000);
});
