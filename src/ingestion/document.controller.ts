import { Body, Controller, Param, ParseUUIDPipe, Post, Get, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsString, IsUUID, Max, Min } from 'class-validator';
import { DocumentService } from './document.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../auth/auth.guards';
import type { RequestWithAuth } from '../auth/auth.types';

class CreateUploadDto {
  @IsString() @IsNotEmpty() filename!: string;
  @IsString() @IsNotEmpty() contentType!: string;
  @IsInt() @Min(1) @Max(26214400) byteSize!: number;
}

class CompleteUploadDto {
  @IsUUID() versionId!: string;
}

@Controller('documents')
@UseGuards(AccessTokenGuard, WorkspaceMemberGuard)
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Post()
  createUpload(@Req() request: RequestWithAuth, @Body() body: CreateUploadDto) {
    return this.documents.createUpload({ workspaceId: request.workspaceId!, ...body });
  }

  @Post(':documentId/complete')
  completeUpload(
    @Req() request: RequestWithAuth,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() body: CompleteUploadDto,
  ) {
    return this.documents.completeUpload(request.workspaceId!, documentId, body.versionId);
  }

  @Get(':documentId')
  status(@Req() request: RequestWithAuth, @Param('documentId', new ParseUUIDPipe()) documentId: string) {
    return this.documents.status(request.workspaceId!, documentId);
  }
}