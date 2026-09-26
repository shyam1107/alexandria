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
        const text = result.text.trim();
        // A scanned PDF has no text layer: extraction yields only page
        // furniture (numbers, headers) or nothing. Indexing that garbage
        // makes the document "searchable" for queries it can never answer.
        // Fail honestly instead — the user needs OCR, not a silent dud.
        if (text.replace(/[^a-zA-Z0-9]/g, '').length < 20) {
          throw new UnprocessableEntityException('PDF has no extractable text (likely scanned images); run OCR before uploading');
        }
        return { text, parserVersion: 'pdf-parse-2' };
      } catch (error) {
        // "No password given" / "Incorrect Password": the PDF carries a user
        // password (bank statements, invoices). We never accept passwords —
        // decrypt locally before uploading. Raw message is cryptic in the UI.
        if (error instanceof Error && /password/i.test(error.message)) {
          throw new UnprocessableEntityException('PDF is password-protected; decrypt it before uploading');
        }
        throw error;
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