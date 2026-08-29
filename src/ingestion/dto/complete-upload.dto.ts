import { IsUUID } from 'class-validator';

export class CompleteUploadDto {
  @IsUUID()
  versionId!: string;
}
