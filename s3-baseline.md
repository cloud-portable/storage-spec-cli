# S3 API Operations

## Bucket Operations

- CreateBucket (PUT Bucket)
- DeleteBucket (DELETE Bucket)
- HeadBucket (HEAD Bucket - check if a bucket exists and you have permission to access it)
- ListBuckets (GET Service - list all buckets owned by the authenticated sender)
- ListObjects / ListObjectsV2 (GET Bucket - list the contents of a bucket)

## Object Operations

- PutObject (PUT Object - upload a file)
- GetObject (GET Object - download a file)
- HeadObject (HEAD Object - retrieve metadata without downloading the file)
- DeleteObject (DELETE Object)
- DeleteObjects (Bulk Delete / Multi-Object Delete - delete multiple objects in a single request)
- CopyObject (PUT Object - Copy - copy an object from one bucket/path to another server-side)

## Multipart Uploads

Because S3 limits standard PUT operations to 5GB, all five implementations explicitly support the Multipart Upload API to handle large files reliably.

- CreateMultipartUpload (Initiate Multipart Upload)
- UploadPart
- UploadPartCopy
- CompleteMultipartUpload
- AbortMultipartUpload
- ListParts (List uploaded parts for an ongoing multipart upload)
- ListMultipartUploads (List multipart uploads that have not yet been completed or aborted)
