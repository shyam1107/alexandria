import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class SearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  query!: string;

  // Results returned after fusion. Capped at 50: beyond that the tail of an
  // RRF merge is noise, and deep pagination over search results is an
  // anti-pattern — tighten the query instead.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  /** Restrict retrieval to a single document (chat-with-this-document mode). */
  @IsOptional()
  @IsUUID()
  documentId?: string;

  /** Include per-signal ranks/scores — the retrieval debugging view. */
  @IsOptional()
  @IsBoolean()
  debug?: boolean;
}
