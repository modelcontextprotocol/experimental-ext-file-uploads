import { markedFile, type FileInput } from './common';

export const ORDER_BYTES = Buffer.from('id,total\n1,3\n');
export const ORDER_MIME_TYPE = 'text/csv';

export const DOWNLOAD_CASES = ['valid', 'short', 'wrong-digest'] as const;
export type DownloadCase = (typeof DOWNLOAD_CASES)[number];
export const downloadFilename = 'orders.csv';

export const FORM_FIELDS = [
  { name: 'policy', value: 'first' },
  { name: 'key', value: 'second' },
  { name: 'policy', value: 'third' }
];
export const FORM_FILE_FIELD = 'payload';
export const FORM_FILENAME = 'nested\\other/ordérs"\r\n.txt';

function sample(id: string, text: string, name = id + '.txt') {
  const bytes = Buffer.from(text);
  const file: FileInput = {
    id,
    name,
    mimeType: 'text/plain',
    size: bytes.length
  };
  return { bytes, file };
}
const first = sample('first', 'abc');
const second = sample('second', 'second file');
const form = sample('file', 'form bytes', FORM_FILENAME);
const single = sample('file', 'abc');

export const UPLOAD_CASES = {
  raw: { name: 'save_files', files: { first, second } },
  form: { name: 'save_to_folder', files: { file: form } },
  failed: { name: 'save_files', files: { first, second } },
  second: { name: 'save_to_folder', files: { file: single } },
  invalid: { name: 'save_to_folder', files: { file: single } }
} as const;
export type UploadCase = keyof typeof UPLOAD_CASES;

export function sampleCall(profile: UploadCase) {
  const { name, files } = UPLOAD_CASES[profile];
  return {
    name,
    arguments: {
      folderId: profile,
      ...Object.fromEntries(
        Object.entries(files).map(([key, { file }]) => [key, file])
      )
    }
  };
}

export function saveTools(maxSizes: Partial<Record<string, number>> = {}) {
  return [
    {
      name: 'save_to_folder',
      description: 'Save a file to the requested folder.',
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string' },
          file: markedFile({ accept: ['text/plain'] })
        },
        required: ['folderId', 'file']
      }
    },
    {
      name: 'save_files',
      description: 'Save multiple file arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string' },
          first: markedFile({ maxSize: maxSizes.first }),
          second: markedFile({ maxSize: maxSizes.second }),
          empty: markedFile({ maxSize: maxSizes.empty })
        },
        required: ['first', 'second']
      }
    }
  ];
}
