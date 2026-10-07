export type JobStatus = "QUEUING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface ToolArgument {
  name: string;
  value: unknown;
}

export interface StoredOutput {
  index: number;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width?: number;
  height?: number;
}

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface InlineReferenceImage {
  base64: string;
  mime_type: ImageMimeType;
}

export interface GenerationReferenceImage {
  generation_id: string;
  index: number;
}

export type ReferenceImage = InlineReferenceImage | GenerationReferenceImage;

export interface ImageRequest {
  prompt: string;
  aspectRatio: string;
  imageCount: number;
  references: InlineReferenceImage[];
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: string;
}

export interface GenerationJob {
  generationId: string;
  taskTraceId?: string;
  model: string;
  request?: ImageRequest;
  status: JobStatus;
  queuePosition?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  outputs?: StoredOutput[];
  error?: JobError;
}
