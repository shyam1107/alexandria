import { Body, Controller, Param, ParseUUIDPipe, Post, Get, Req, UseGuards } from '@nestjs/common';
import { DocumentService } from './document.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../auth/auth.guards';
import type { RequestWithAuth } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';

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