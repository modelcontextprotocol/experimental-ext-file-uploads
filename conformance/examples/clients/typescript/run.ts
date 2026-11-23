import { runFilesDownloadClient, runFilesUploadClient } from './file-uploads';
import { connectTypeScriptSdk } from './sdk';

const [url] = process.argv.slice(2);
const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
if (!url) throw new Error('The fixture needs an MCP URL.');
if (scenario === 'file-uploads-client-upload') {
  await runFilesUploadClient(url, undefined, connectTypeScriptSdk);
} else if (scenario === 'file-uploads-client-download') {
  await runFilesDownloadClient(url, false, connectTypeScriptSdk);
} else {
  throw new Error('Unknown File Uploads client scenario.');
}
