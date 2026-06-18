import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import Handlebars from 'handlebars';

interface TestCase {
  name: string;
  className: string;
  time: number;
  status: 'PASS' | 'FAIL';
  failureMessage?: string;
  failureStack?: string;
}

const OPERATION_MAPPING: { name: string; match: (testName: string) => boolean }[] = [
  { name: 'CreateBucket', match: (name) => name.includes('test_bucket_create') },
  { name: 'HeadBucket', match: (name) => name.includes('test_bucket_head') },
  { name: 'DeleteBucket', match: (name) => name.includes('test_bucket_delete') },
  { name: 'PutObject', match: (name) => name.includes('test_object_write') || name.includes('test_object_put') },
  { name: 'HeadObject', match: (name) => name.includes('test_object_head') },
  { name: 'GetObject', match: (name) => name.includes('test_object_read') || name.includes('test_object_get') },
  // Match DeleteObjects (multi-delete) before DeleteObject to avoid false positives
  { name: 'DeleteObjects', match: (name) => name.includes('test_multi_object_delete') || name.includes('test_multi_objectv2_delete') },
  { name: 'DeleteObject', match: (name) => name.includes('test_object_delete') && !name.includes('test_multi_object_delete') && !name.includes('test_multi_objectv2_delete') },
  { name: 'ListObjectsV2', match: (name) => name.includes('test_bucket_listv2') },
  { name: 'ListBuckets', match: (name) => name.includes('test_buckets_create_then_list') || name.includes('test_list_buckets') },
  { name: 'CopyObject', match: (name) => name.includes('test_object_copy') }
];

function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

export async function reportCommand(opts: any) {
  const junitPath = opts.junit;
  const metadataPath = opts.metadata;
  const outputPath = opts.output;

  if (!junitPath || !metadataPath || !outputPath) {
    throw new Error('Arguments --junit, --metadata, and --output are required.');
  }

  if (!existsSync(junitPath)) {
    throw new Error(`JUnit XML file not found at ${junitPath}`);
  }
  if (!existsSync(metadataPath)) {
    throw new Error(`Metadata file not found at ${metadataPath}`);
  }

  let templatePath = opts.template;
  if (!templatePath) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    templatePath = path.resolve(currentDir, './report-template.html');
  } else {
    templatePath = path.resolve(process.cwd(), templatePath);
  }

  if (!existsSync(templatePath)) {
    throw new Error(`HTML Report Template not found at ${templatePath}`);
  }

  console.log(`Compiling HTML report using JUnit: ${junitPath}, Metadata: ${metadataPath}`);

  // Load Metadata
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

  // Load JUnit XML and parse
  const xmlContent = await fs.readFile(junitPath, 'utf8');
  const testcases: TestCase[] = [];

  const testCaseRegex = /<testcase\s+([^>]+)\/>|<testcase\s+([^>]+)>([\s\S]*?)<\/testcase>/g;
  const matches = xmlContent.matchAll(testCaseRegex);

  for (const match of matches) {
    const isSelfClosing = match[1] !== undefined;
    const attrsStr = (isSelfClosing ? match[1] : match[2]) || '';
    const body = isSelfClosing ? '' : (match[3] || '');

    const name = (attrsStr.match(/\bname="([^"]+)"/) || [])[1] || '';
    const classname = (attrsStr.match(/\bclassname="([^"]+)"/) || [])[1] || '';
    const time = parseFloat((attrsStr.match(/time="([^"]+)"/) || [])[1] || '0');

    let status: 'PASS' | 'FAIL' = 'PASS';
    let failureMessage = '';
    let failureStack = '';

    if (!isSelfClosing) {
      const failMatch = body.match(/<(failure|error)\s+message="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/);
      if (failMatch) {
        status = 'FAIL';
        failureMessage = unescapeXml(failMatch[2] || '');
        failureStack = unescapeXml((failMatch[3] || '').trim());
      } else if (body.includes('<failure') || body.includes('<error')) {
        status = 'FAIL';
        failureMessage = 'Test failed (no message specified)';
        const stackMatch = body.match(/<(failure|error)[^>]*>([\s\S]*?)<\/\1>/);
        if (stackMatch) {
          failureStack = unescapeXml((stackMatch[2] || '').trim());
        }
      }
    }

    testcases.push({
      name,
      className: classname,
      time,
      status,
      failureMessage,
      failureStack
    });
  }

  console.log(`Parsed ${testcases.length} test cases from JUnit XML.`);

  // Calculate operation conformance status
  // An operation maps to multiple tests.
  // We keep track of tests per operation and whether they pass/fail.
  const opResults: Record<string, { total: number; passed: number; failed: number; tests: TestCase[] }> = {};
  for (const mapping of OPERATION_MAPPING) {
    opResults[mapping.name] = { total: 0, passed: 0, failed: 0, tests: [] };
  }

  for (const tc of testcases) {
    let matchedOp = false;
    for (const mapping of OPERATION_MAPPING) {
      if (mapping.match(tc.name)) {
        const res = opResults[mapping.name]!;
        res.total++;
        if (tc.status === 'PASS') {
          res.passed++;
        } else {
          res.failed++;
        }
        res.tests.push(tc);
        matchedOp = true;
      }
    }
    if (!matchedOp) {
      // Unmapped test, we can attribute it to a default or just log it
    }
  }

  // Count total passed and failed
  let totalPassedOps = 0;
  let totalFailedOps = 0;
  let totalPassedCases = 0;
  let totalFailedCases = 0;

  for (const [opName, res] of Object.entries(opResults)) {
    if (res.total > 0) {
      if (res.failed === 0) {
        totalPassedOps++;
      } else {
        totalFailedOps++;
      }
    }
    totalPassedCases += res.passed;
    totalFailedCases += res.failed;
  }

  const totalCasesRun = totalPassedCases + totalFailedCases;

  // Clean version presentation (e.g. "Garage v0.9.4" or "Mock")
  const targetVersionText = metadata.targetEngine.includes('v') 
    ? metadata.targetEngine 
    : `${metadata.targetEngine} ${metadata.targetUrl}`;

  // Fail badge html
  let badgeFailHtml = '';
  if (totalFailedCases > 0) {
    badgeFailHtml = `<span class="badge-right red" id="badge-fail-btn" title="Click to jump to failure details">${totalFailedCases} Fail</span>`;
  } else {
    badgeFailHtml = `<span class="badge-right green" id="badge-fail-btn" style="background-color: var(--accent-green-transparent); color: var(--accent-green);" title="All tests passed">0 Fail</span>`;
  }

  // Matrix Cards HTML
  let matrixCardsHtml = '';
  for (const mapping of OPERATION_MAPPING) {
    const res = opResults[mapping.name]!;
    if (res.total === 0) {
      // Untested / skipped
      matrixCardsHtml += `
        <div class="op-card" data-op="${mapping.name}" id="op-${mapping.name}" style="opacity: 0.6;">
          <span class="op-name">${mapping.name}</span>
          <div class="status-indicator" style="color: var(--text-secondary);">
            <!-- <div class="status-dot" style="background-color: var(--text-secondary);"></div> -->
            <span>Skip</span>
          </div>
        </div>`;
    } else if (res.failed === 0) {
      // Passed
      matrixCardsHtml += `
        <div class="op-card" data-op="${mapping.name}" id="op-${mapping.name}">
          <span class="op-name">${mapping.name}</span>
          <div class="status-indicator status-pass">
            <div class="status-dot"></div>
            <span>OK</span>
          </div>
        </div>`;
    } else {
      // Failed
      matrixCardsHtml += `
        <div class="op-card" data-op="${mapping.name}" id="op-${mapping.name}">
          <!-- <span class="op-name" style="color: var(--accent-red);">${mapping.name}</span> -->
          <span class="op-name"">${mapping.name}</span>
          <div class="status-indicator status-fail" id="status-${mapping.name}">
            <!-- div class="status-dot"></div> -->
            <span>${res.failed} FAIL</span>
          </div>
        </div>`;
    }
  }

  // Test List HTML using Handlebars
  const testTemplateSrc = `
    {{#each tests}}
      <div class="test-item" data-for-ops="{{mappingName}}" {{{failAttrs}}}>
        <details {{{detailsAttrs}}}>
          <summary class="test-header" {{{headerStyles}}}>
            <span class="test-name" {{#if isFail}}style="color: var(--accent-red);"{{/if}}>{{cleanTestName}}</span>
            <div class="test-meta">
              <span class="test-duration">{{time}}s</span>
              <span class="badge {{#if isFail}}badge-error{{else}}badge-success{{/if}}">{{status}}</span>
            </div>
          </summary>
          <div class="test-details">
            {{#if isFail}}
              <div class="test-error-msg">{{failureMessage}}</div>
              <div class="code-label">Traceback</div>
              <div class="test-stack">{{failureStack}}</div>
            {{else}}
              <p style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                Operation conformance verification tests successfully passed against target endpoint.
              </p>
            {{/if}}
            <a href="https://github.com/ceph/s3-tests/blob/5522d1c351f75bc00ae0f64f742f3f095f5939d9/s3tests/functional/test_s3.py" target="_blank" rel="noopener" class="external-run-link">
              View Source Code on Github &nearr;
            </a>
          </div>
        </details>
      </div>
    {{/each}}
  `;

  const formattedTests = [];
  let firstFailMarked = false;

  for (const mapping of OPERATION_MAPPING) {
    const res = opResults[mapping.name]!;
    for (const tc of res.tests) {
      const isFail = tc.status === 'FAIL';
      let failAttrs = '';
      let headerStyles = '';
      let detailsAttrs = '';
      
      if (isFail) {
        failAttrs = 'style="border-color: var(--accent-red)"';
        headerStyles = 'style="background-color: rgba(239, 68, 68, 0.05)"';
        
        // Add specific IDs to the first failure so the jump button scrolls to it
        if (!firstFailMarked) {
          failAttrs = 'id="test-fail-item" style="border-color: var(--accent-red)"';
          headerStyles = 'id="test-fail-header" style="background-color: rgba(239, 68, 68, 0.05)"';
          detailsAttrs = 'id="test-fail-details"';
          firstFailMarked = true;
        }
      }

      const cleanTestName = tc.name.replace('s3tests.functional.test_s3.', 's3tests.functional.test_s3::');

      formattedTests.push({
        mappingName: mapping.name,
        failAttrs,
        detailsAttrs,
        headerStyles,
        isFail,
        cleanTestName,
        time: tc.time.toFixed(2),
        status: tc.status,
        failureMessage: tc.failureMessage || 'AssertionError',
        failureStack: tc.failureStack || 'No traceback available.'
      });
    }
  }

  const testListTemplate = Handlebars.compile(testTemplateSrc);
  let testListHtml = testListTemplate({ tests: formattedTests });

  if (testListHtml === '') {
    testListHtml = '<p style="padding: 1.5rem; text-align: center; color: var(--text-secondary);">No tests matched or executed.</p>';
  }

  // Provenance rows HTML
  const provenanceRows = [
    { label: 'Target', value: `<code>${metadata.targetEngine}</code>` },
    { label: 'Test Suite', value: `<a href="https://github.com/ceph/s3-tests/commit/${metadata.testSuiteCommit}" target="_blank" rel="noopener"><code>s3-tests@${metadata.testSuiteCommit.substring(0, 7)}</code></a>` },
    { label: 'Spec Version', value: `<a href="https://github.com/cloud-portable/storage/commit/${metadata.specVersionCommit}" target="_blank" rel="noopener"><code>storage@${metadata.specVersionCommit.substring(0, 7)}</code></a>` },
    { label: 'Created At', value: `${metadata.timestamp.replace('T', ' ').replace(/\.\d+Z/, ' UTC')}` }
  ];
  let provenanceRowsHtml = '';
  for (const row of provenanceRows) {
    provenanceRowsHtml += `
              <div class="meta-row">
                <span class="label">${row.label}</span>
                <span class="value">${row.value}</span>
              </div>`;
  }

  // Recreation commands HTML
  // Let's generate it based on target URL/Engine
  const containerCmd = metadata.targetEngine.toLowerCase().includes('garage')
    ? 'docker run -d --name garage-target \\\n  -p 3900:3900 -p 3902:3902 dxflrs/garage:v0.9.4'
    : 'docker run -d --name localstack-target \\\n  -p 4566:4566 localstack/localstack';
  
  const recreationCommandsHtml = `
            <div class="code-container">
              <div class="code-label">1. Start Local Target Container</div>
              <pre class="command-block">${containerCmd}</pre>
            </div>
 
            <div class="code-container">
              <div class="code-label">2. Run Conformance Test Suite</div>
              <pre class="command-block">storage-spec verify --target ${metadata.targetUrl} \\
  --access-key admin --secret-key admin \\
  --tier ../storage/tier-1.yaml</pre>
            </div>`;

  // Run history HTML
  const historyOpt = opts['run-history'] || '';
  let runHistoryHtml = '';
  if (historyOpt) {
    const versions = historyOpt.split(',');
    versions.forEach((ver: string, idx: number) => {
      if (idx === 0) {
        runHistoryHtml += `<span class="current">${ver} (latest)</span>\n`;
      } else {
        runHistoryHtml += `<a href="#">${ver}</a>\n`;
      }
    });
  } else {
    runHistoryHtml = `<span class="current">v0.9.4 (latest)</span>`;
  }

  // See also HTML
  const seeAlsoOpt = opts['see-also'] || '';
  let seeAlsoHtml = '';
  if (seeAlsoOpt) {
    const links = seeAlsoOpt.split(',');
    links.forEach((link: string) => {
      const [name, url] = link.split('=');
      seeAlsoHtml += `<a href="${url}">${name}</a>\n`;
    });
  } else {
    seeAlsoHtml = `<a href="mock-report-localstack.html">LocalStack</a>\n<a href="#">MinIO</a>`;
  }

  // Render Page via Handlebars
  const pageTemplateSrc = await fs.readFile(templatePath, 'utf8');
  const pageTemplate = Handlebars.compile(pageTemplateSrc);

  const finalHtml = pageTemplate({
    TARGET_ENGINE: metadata.targetEngine || 'S3 Endpoint',
    TARGET_ENGINE_VERSION: targetVersionText,
    TIER_NAME: metadata.tier || 'Tier 1 (Core)',
    BADGE_OK_TEXT: `${totalPassedCases} OK`,
    BADGE_FAIL_HTML: badgeFailHtml,
    MATRIX_CARDS_HTML: matrixCardsHtml,
    TESTS_CARD_TITLE: `Test Suite Execution Details (${totalPassedCases}/${totalCasesRun} Passed)`,
    TEST_LIST_HTML: testListHtml,
    PROVENANCE_ROWS_HTML: provenanceRowsHtml,
    RECREATION_COMMANDS_HTML: recreationCommandsHtml,
    RUN_HISTORY_HTML: runHistoryHtml,
    SEE_ALSO_HTML: seeAlsoHtml
  });

  // Write compiled report HTML
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, finalHtml, 'utf8');
  console.log(`Compiled report successfully written to ${outputPath}`);
}
