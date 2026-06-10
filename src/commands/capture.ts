import sade from 'sade';
import http from 'http';
import httpProxy from 'http-proxy';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

interface RouteCandidate {
    id: string;
    method: string;
    pathRegex: RegExp;
    literalQuery: string | null;
    queryParams: string[];
    headerParams: string[];
    requiredQueryParams: string[];
    requiredHeaderParams: string[];
}

export async function captureCommand(opts: any) {
    const targetUrl = opts.target;
    if (!targetUrl) throw new Error('--target is required');

    const testCommand = opts._ && opts._.length > 0 ? opts._.join(' ') : opts['test-command'];
    if (!testCommand) throw new Error('A test command is required (e.g. storage-spec capture --target http://localhost:9000 -- npm test)');

    const specsDir = path.join(process.cwd(), 'specs');
    const baselinePath = path.join(specsDir, 's3-baseline.json');
    const compatiblePath = path.join(specsDir, 'compatible-s3.json');

    if (!existsSync(baselinePath)) {
        throw new Error('s3-baseline.json not found. Run "storage-spec init" first.');
    }

    const ast = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const routerMap: RouteCandidate[] = [];

    const operations = ast.shapes['com.amazonaws.s3#AmazonS3'].operations;
    for (const op of operations) {
        const opId = op.target;
        const opShape = ast.shapes[opId];
        if (!opShape) continue;

        const httpTrait = opShape.traits?.['smithy.api#http'];
        if (!httpTrait) continue;

        const [uriPath, uriQuery] = httpTrait.uri.split('?');
        let literalQuery = null;
        if (uriQuery && !uriQuery.startsWith('x-id=')) {
            literalQuery = uriQuery;
        }

        const regexStr = '^' + uriPath.replace(/{[A-Za-z0-9]+}/g, '([^/]+)').replace(/{[A-Za-z0-9]+\+}/g, '(.+)') + '$';

        const queryParams: string[] = [];
        const headerParams: string[] = [];
        const requiredQueryParams: string[] = [];
        const requiredHeaderParams: string[] = [];

        const inputShapeId = opShape.input?.target;
        if (inputShapeId) {
            const inputShape = ast.shapes[inputShapeId];
            if (inputShape?.members) {
                for (const memberDef of Object.values<any>(inputShape.members)) {
                    const isRequired = !!memberDef.traits?.['smithy.api#required'];
                    if (memberDef.traits?.['smithy.api#httpQuery']) {
                        const q = memberDef.traits['smithy.api#httpQuery'];
                        queryParams.push(q);
                        if (isRequired) requiredQueryParams.push(q);
                    }
                    if (memberDef.traits?.['smithy.api#httpHeader']) {
                        const h = memberDef.traits['smithy.api#httpHeader'].toLowerCase();
                        headerParams.push(h);
                        if (isRequired) requiredHeaderParams.push(h);
                    }
                }
            }
        }

        routerMap.push({
            id: opId,
            method: httpTrait.method,
            pathRegex: new RegExp(regexStr),
            literalQuery,
            queryParams,
            headerParams,
            requiredQueryParams,
            requiredHeaderParams
        });
    }

    console.log(`Loaded ${routerMap.length} S3 baseline operations into router.`);

    const observedOps = new Set<string>();

    const proxy = httpProxy.createProxyServer({
        target: targetUrl,
        secure: false,
        changeOrigin: true
    });

    proxy.on('proxyRes', (proxyRes: any, req: any, res: any) => {
        if (proxyRes.statusCode && proxyRes.statusCode < 400) {
            const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const pathname = reqUrl.pathname;
            const method = req.method || 'GET';

            const candidates = routerMap.filter(r => r.method === method && r.pathRegex.test(pathname));

            let bestMatch: RouteCandidate | null = null;
            let highestScore = -9999;

            for (const c of candidates) {
                let score = 0;
                let valid = true;

                if (c.literalQuery) {
                    if (reqUrl.searchParams.has(c.literalQuery)) {
                        score += 100;
                    } else {
                        valid = false;
                    }
                }

                for (const rq of c.requiredQueryParams) {
                    if (!reqUrl.searchParams.has(rq)) valid = false;
                }
                for (const rh of c.requiredHeaderParams) {
                    if (!req.headers[rh]) valid = false;
                }

                let penalty = 0;
                for (const q of c.queryParams) {
                    if (reqUrl.searchParams.has(q)) {
                        score += 10;
                    } else {
                        penalty += 1;
                    }
                }
                for (const h of c.headerParams) {
                    if (req.headers[h]) {
                        score += 10;
                    }
                }
                score -= penalty;

                if (valid && score > highestScore) {
                    highestScore = score;
                    bestMatch = c;
                }
            }

            if (bestMatch) {
                observedOps.add(bestMatch.id);
                console.log(`[PROXY] MATCHED: ${method} ${pathname} -> ${bestMatch.id.split('#')[1]}`);
            } else {
                console.log(`[PROXY] UNMATCHED: ${method} ${pathname}`);
            }
        }
    });

    const server = http.createServer((req: any, res: any) => {
        proxy.web(req, res, { target: targetUrl }, (err: any) => {
            console.error(`[PROXY] Error forwarding ${req.url}:`, err.message);
            res.writeHead(502);
            res.end();
        });
    });

    return new Promise<void>((resolve, reject) => {
        server.listen(8080, () => {
            console.log(`Proxy listening on http://localhost:8080. Forwarding to ${targetUrl}`);
            console.log(`Executing test command: ${testCommand}`);

            const child = spawn(testCommand, {
                shell: true,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    AWS_ENDPOINT_URL: 'http://localhost:8080',
                    AWS_ACCESS_KEY_ID: 'test',
                    AWS_SECRET_ACCESS_KEY: 'test',
                    AWS_REGION: 'us-east-1'
                }
            });

            child.on('close', async (code: number | null) => {
                console.log(`Test command exited with code ${code}`);
                server.close();
                
                try {
                    console.log(`Writing compatible-s3.json with ${observedOps.size} operations...`);
                    const filteredOperations = operations.filter((op: any) => observedOps.has(op.target));
                    ast.shapes['com.amazonaws.s3#AmazonS3'].operations = filteredOperations;
                    await fs.writeFile(compatiblePath, JSON.stringify(ast, null, 2));
                    console.log(`Successfully wrote ${compatiblePath}`);
                    resolve();
                } catch(e) {
                    reject(e);
                }
            });
        });
    });
}
