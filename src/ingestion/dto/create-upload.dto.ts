import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateUploadDto {
  @IsString()
  @IsNotEmpty()
  filename!: string;

  @IsString()
  @IsNotEmpty()
  contentType!: string;

  // No @Max here: the ceiling is MAX_DOCUMENT_BYTES, which is configuration.
  // Hardcoding it in the DTO would silently override the env var.
  @IsInt()
  @Min(1)
  byteSize!: number;
}
