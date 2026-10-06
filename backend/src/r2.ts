import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import 'dotenv/config';

export function r2Storage(): { client: S3Client; bucket: string } {
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('configure R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY before generating songs.');
  }
  return {
    bucket,
    client: new S3Client({
      region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
    }),
  };
}

export async function putSongObject(key: string, audio: Buffer): Promise<void> {
  const { client, bucket } = r2Storage();
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: audio, ContentType: 'audio/mpeg',
  }));
}

export async function deleteSongObject(key: string): Promise<void> {
  const { client, bucket } = r2Storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function readSongObject(key: string, range?: string): Promise<{ audio: Buffer; contentRange?: string }> {
  const { client, bucket } = r2Storage();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
  if (!result.Body) throw new Error('song storage returned no audio.');
  return { audio: Buffer.from(await result.Body.transformToByteArray()), contentRange: result.ContentRange };
}
