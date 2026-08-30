import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;

  /** Omit to start a new conversation. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /**
   * Idempotency key for the user turn. A retry after a crash or disconnect
   * replays the stored answer instead of generating (and billing) a second
   * one. Unique per conversation.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientMessageId?: string;

  /** Adds the rewritten query and retrieval diagnostics to the sources frame. */
  @IsOptional()
  @IsBoolean()
  debug?: boolean;
}
