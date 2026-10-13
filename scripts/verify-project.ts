import { parseArgs } from 'node:util';
import { verificationFailureMessage, verifyProject } from './project-verification.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'project-id': { type: 'string' }, 'project-name': { type: 'string' } },
    allowPositionals: false,
  });
  if (!values['project-id'] || !values['project-name']) {
    console.error('Usage: npm run verify:project -- --project-id <approved ID> --project-name <exact name>');
    process.exitCode = 1;
    return;
  }
  const result = await verifyProject({
    env: process.env,
    projectId: values['project-id'],
    projectName: values['project-name'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.stepsAvailable) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(verificationFailureMessage(error));
  process.exitCode = 1;
});
