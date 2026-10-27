// 在测试 MinIO 里创建 pan-test 桶
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin123' },
});
await client.send(new CreateBucketCommand({ Bucket: 'pan-test' })).catch((e) => {
  if (e.name !== 'BucketAlreadyOwnedByYou') throw e;
});
console.log('bucket pan-test ready');
