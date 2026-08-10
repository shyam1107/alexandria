import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export interface ParsedDocument {
  text: string;
  parserVersion: string;
}

@Injectable()
export class ParserService {
  async parse(buffer: Buffer, contentType: string, filename: string): Promise<ParsedDocument> {
    const extension = filename.toLowerCase().split('.').pop();
    if (contentType === 'application/pdf' || extension === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return { text: result.text.trim(), parserVersion: 'pdf-parse-2' };
      } finally {
        await parser.destroy();
      }
    }
    if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value.trim(), parserVersion: 'mammoth-1' };
    }
    if (contentType.startsWith('text/') || extension === 'md' || extension === 'markdown' || extension === 'txt') {
      return { text: buffer.toString('utf8').trim(), parserVersion: 'text-1' };
    }
    throw new UnprocessableEntityException(`Unsupported document type: ${contentType}`);
  }
}