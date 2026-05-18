import mongoose from 'mongoose';
import axios from 'axios';
import KnowledgeBase from '../models/KnowledgeBase';
import KnowledgeBaseDocument from '../models/KnowledgeBaseDocument';
import ChatbotKnowledgeBase from '../models/ChatbotKnowledgeBase';
import FAQ from '../models/FAQ';
import Website from '../models/Website';
import File from '../models/File';
import { AppError } from '../middleware/error.middleware';
import { ragService } from './rag.service';
import { pythonRagService } from './pythonRag.service';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';

// Python API base URL - use COMM_API_URL if PYTHON_API_URL is not set (for consistency)
const PYTHON_API_BASE_URL = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

export class KnowledgeBaseService {
  // New Unified Ingestion Method
  async ingestDocument(userId: string, data: {
    source_type: 'text' | 'url' | 'file';
    name?: string;
    parent_folder_id?: string;
    text?: string;
    url?: string;
    file?: Express.Multer.File;
  }) {
    const { source_type, name, parent_folder_id, text, url, file } = data;

    // 1. Validation
    if (source_type === 'text' && !text) {
      throw new AppError(422, 'VALIDATION_ERROR', 'text is required for source_type=text');
    }
    if (source_type === 'url' && !url) {
      throw new AppError(422, 'VALIDATION_ERROR', 'url is required for source_type=url');
    }
    if (source_type === 'file' && !file) {
      throw new AppError(422, 'VALIDATION_ERROR', 'file is required for source_type=file');
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const userIdObjectId = new mongoose.Types.ObjectId(userId);
    
    console.log(`[KB Service] ingestDocument - userId string: ${userId}, ObjectId: ${userIdObjectId}`);
    console.log(`[KB Service] Calling both RAG API and Python API simultaneously...`);

    // Prepare KB name
    const kbName = (name || (source_type === 'file' ? file?.originalname : (source_type === 'url' ? url : 'Untitled Document'))) ?? 'Untitled Document';
    
    // Generate collection name from KB name (sanitize for Python/Chroma) - same logic as legacy create method
    // This ensures the collection name matches what's actually used in the RAG API
    const collectionName = kbName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
    
    // Determine if we should create ChatbotKnowledgeBase (before API calls)
    const shouldCreateChatbotKB = (source_type === 'url' && url) || 
                                    (source_type === 'file' && file && 
                                     (file.mimetype === 'application/pdf' || 
                                      file.mimetype?.includes('spreadsheet') || 
                                      file.mimetype?.includes('excel')));
    
    // 2. Call both APIs simultaneously
    const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/knowledge-base/ingest`;
    
    try {
      const FormData = require('form-data');
      
      // Prepare Python API call (for calling agents) - DO NOT send parent_folder_id
      const pythonFormData = new FormData();
      pythonFormData.append('source_type', source_type);
      pythonFormData.append('name', kbName);
      // Don't append parent_folder_id - leave it out completely
      
      // Add source-specific fields
      if (source_type === 'text') {
        pythonFormData.append('text', text || '');
        pythonFormData.append('url', '');
        pythonFormData.append('file', Buffer.from(''), { filename: '', contentType: 'application/octet-stream' });
      } else if (source_type === 'url') {
        pythonFormData.append('text', '');
        pythonFormData.append('url', url || '');
        pythonFormData.append('file', Buffer.from(''), { filename: '', contentType: 'application/octet-stream' });
      } else if (source_type === 'file' && file) {
        pythonFormData.append('text', '');
        pythonFormData.append('url', '');
        pythonFormData.append('file', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype,
        });
      } else {
        pythonFormData.append('text', '');
        pythonFormData.append('url', '');
        pythonFormData.append('file', Buffer.from(''), { filename: '', contentType: 'application/octet-stream' });
      }

      // Prepare RAG API call (for chatbot usage)
      const ragApiPromise = (async () => {
        try {
          if (source_type === 'url' && url) {
            // Call RAG API with URL
            await pythonRagService.ingestData({
              collectionName: collectionName,
              urlLinks: [url],
            });
            console.log(`[KB Service] ✅ RAG API ingestion completed for URL`);
          } else if (source_type === 'file' && file) {
            // Determine file type and call RAG API
            const isPdf = file.mimetype === 'application/pdf';
            const isExcel = file.mimetype?.includes('spreadsheet') || 
                          file.mimetype?.includes('excel') ||
                          file.mimetype?.includes('vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            
            if (isPdf) {
              await pythonRagService.ingestData({
                collectionName: collectionName,
                pdfFiles: [file.buffer],
              });
              console.log(`[KB Service] ✅ RAG API ingestion completed for PDF`);
            } else if (isExcel) {
              await pythonRagService.ingestData({
                collectionName: collectionName,
                excelFiles: [file.buffer],
              });
              console.log(`[KB Service] ✅ RAG API ingestion completed for Excel`);
            } else {
              console.log(`[KB Service] ⚠️  File type ${file.mimetype} not supported by RAG API, skipping RAG ingestion`);
            }
          } else if (source_type === 'text' && text) {
            // RAG API doesn't support direct text ingestion, skip
            console.log(`[KB Service] ⚠️  Text ingestion not supported by RAG API, skipping RAG ingestion`);
          }
        } catch (ragError: any) {
          console.error(`[KB Service] ⚠️  RAG API ingestion failed:`, ragError.message);
          // Don't throw - continue with Python API
        }
      })();

      // Log the payload being sent
      console.log('\n========== KB CREATION - DUAL API CALL ==========');
      console.log(`[KB Service] Python API Endpoint: ${pythonUrl}`);
      console.log(`[KB Service] RAG API Collection: ${collectionName}`);
      console.log(`[KB Service] Method: POST (both APIs)`);
      console.log(`[KB Service] Content-Type: multipart/form-data`);
      console.log(`[KB Service] Payload:`, {
        source_type: source_type,
        name: kbName,
        parent_folder_id: 'NOT SENT (removed)',
        text: source_type === 'text' ? (text ? `${text.substring(0, 50)}...` : '') : '',
        url: source_type === 'url' ? (url || '') : '',
        file: source_type === 'file' ? (file ? `${file.originalname} (${file.size} bytes)` : '') : ''
      });
      console.log('================================================\n');

      // Execute both API calls in parallel
      const [pythonResponse, ragResponse] = await Promise.allSettled([
        axios.post(pythonUrl, pythonFormData, {
          headers: pythonFormData.getHeaders(),
          timeout: 600000, // 10 minutes timeout
        }),
        ragApiPromise
      ]);

      // Handle Python API response
      if (pythonResponse.status === 'rejected') {
        throw pythonResponse.reason;
      }

      const pythonResponseData = pythonResponse.value.data;
      console.log(`[KB Service] Python API response:`, pythonResponseData);

      // Check if RAG API succeeded
      const ragApiSucceeded = ragResponse.status === 'fulfilled';
      if (!ragApiSucceeded && shouldCreateChatbotKB) {
        console.warn(`[KB Service] ⚠️  RAG API ingestion failed, but will still create ChatbotKnowledgeBase record`);
      }

      // Generate unique IDs for linking
      const documentId = pythonResponseData.document_id || pythonResponseData.id;
      const chatbotKbId = `kb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Handle folder_path - Python API returns it as array, keep as array or convert to string for storage
      const folderPath = Array.isArray(pythonResponseData.folder_path) 
        ? (pythonResponseData.folder_path.length > 0 ? pythonResponseData.folder_path.join('/') : null)
        : (pythonResponseData.folder_path || null);

      // Store Python API response in KnowledgeBaseDocument (for voice agents)
      const voiceAgentDoc = await KnowledgeBaseDocument.create({
        id: documentId,
        document_id: documentId,
        linked_chatbot_kb_id: shouldCreateChatbotKB ? chatbotKbId : null,
        userId: userIdObjectId,
        name: pythonResponseData.name || kbName,
        source_type: pythonResponseData.source_type || source_type,
        folder_id: parent_folder_id || null,
        folder_path: folderPath,
        status: 'ready',
        source_payload: {
          text: source_type === 'text' ? text : undefined,
          url: source_type === 'url' ? url : undefined,
          file_name: source_type === 'file' ? file?.originalname : undefined,
          file_type: source_type === 'file' ? file?.mimetype : undefined,
          file_size_bytes: source_type === 'file' ? file?.size : undefined,
        },
        ingestion: {
          chunk_count: 0,
          embedding_model: 'text-embedding-3-small',
          vector_store: 'chroma',
        },
        metadata: {},
        created_at_unix: nowUnix,
        updated_at_unix: nowUnix,
      });

      console.log(`[KB Service] ✅ Voice Agent KB saved: ${voiceAgentDoc.document_id}`);

      // Store RAG API response in ChatbotKnowledgeBase (for chatbot usage)
      let chatbotDoc = null;
      if (shouldCreateChatbotKB) {
        try {
          chatbotDoc = await ChatbotKnowledgeBase.create({
            kb_id: chatbotKbId,
            linked_kb_id: documentId,
            userId: userIdObjectId,
            name: kbName,
            collection_name: collectionName,
            source_type: source_type,
            source_payload: {
              text: text ?? undefined,
              url: url ?? undefined,
              file_name: file?.originalname,
              file_type: file?.mimetype,
              file_size_bytes: file?.size,
            },
            status: ragApiSucceeded ? 'ready' : 'failed',
            metadata: {},
            created_at_unix: nowUnix,
            updated_at_unix: nowUnix,
          });
          console.log(`[KB Service] ✅ Chatbot KB saved: ${chatbotDoc.kb_id} (collection: ${collectionName})`);
        } catch (chatbotError: any) {
          console.error(`[KB Service] ⚠️  Failed to create ChatbotKnowledgeBase:`, chatbotError.message);
          // Don't throw - voice agent KB was created successfully
        }
      } else {
        console.log(`[KB Service] ⚠️  Skipping ChatbotKnowledgeBase creation (source_type: ${source_type} not supported by RAG API)`);
      }

      console.log(`[KB Service] ✅ Document created in both RAG API and Python API`);
      console.log(`[KB Service] ✅ Voice Agent KB: ${voiceAgentDoc.document_id}`);
      console.log(`[KB Service] ✅ Chatbot KB: ${chatbotDoc ? chatbotDoc.kb_id : 'N/A (not created)'}`);

      // Link ChatbotKnowledgeBase to Settings if it was created
      if (chatbotDoc) {
        try {
          await this.linkChatbotKBToSettings(userId, chatbotDoc.kb_id, collectionName);
          console.log(`[KB Service] ✅ Linked ChatbotKnowledgeBase to Settings`);
        } catch (linkError: any) {
          console.error(`[KB Service] ⚠️  Failed to link ChatbotKnowledgeBase to Settings:`, linkError.message);
          // Don't throw - KB creation succeeded
        }
      }

      // Return voice agent document (for backward compatibility)
      return voiceAgentDoc;
    } catch (error: any) {
      console.error('[KB Service] Failed to create knowledge base in Python API:', error);
      console.error('[KB Service] Python API URL attempted:', pythonUrl);
      console.error('[KB Service] Error details:', {
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : 'No response'
      });
      
      if (error.response) {
        console.error('[KB Service] Python API error response:', {
          status: error.response.status,
          data: error.response.data
        });
        // If Python API returns 404, provide clearer error message
        if (error.response.status === 404) {
          throw new AppError(
            404,
            'KB_CREATION_ERROR',
            `Python API endpoint not found: ${pythonUrl}. Please check PYTHON_API_URL environment variable.`
          );
        }
        throw new AppError(
          error.response.status || 500,
          'KB_CREATION_ERROR',
          error.response.data?.detail || error.response.data?.message || 'Failed to create knowledge base in Python API'
        );
      }
      
      // Handle network errors (connection refused, etc.)
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new AppError(
          503,
          'KB_CREATION_ERROR',
          `Cannot connect to Python API at ${pythonUrl}. Please ensure the Python service is running.`
        );
      }
      
      throw new AppError(
        500,
        'KB_CREATION_ERROR',
        error.message || 'Failed to create knowledge base'
      );
    }
  }

  private async processDocumentIngestion(mongoId: string, fileBuffer?: Buffer) {
    const doc = await KnowledgeBaseDocument.findById(mongoId);
    if (!doc) return;

    try {
      console.log(`[KB Service] Processing ingestion for doc: ${doc.document_id} (${doc.source_type})`);
      
      const collectionName = `user_${doc.userId.toString()}_kb`;

      if (doc.source_type === 'text' && doc.source_payload.text) {
        // Implement text ingestion (could be via a temporary file or new Python endpoint)
        // For now, let's assume pythonRagService can handle it or we use a placeholder
        console.log('[KB Service] Text ingestion requested');
      } else if (doc.source_type === 'url' && doc.source_payload.url) {
        await pythonRagService.ingestData({
          collectionName,
          urlLinks: [doc.source_payload.url],
        });
      } else if (doc.source_type === 'file' && fileBuffer) {
        const isPdf = doc.source_payload.file_type === 'application/pdf';
        const isExcel = doc.source_payload.file_type?.includes('spreadsheet') || doc.source_payload.file_type?.includes('excel');

        if (isPdf) {
          await pythonRagService.ingestData({
            collectionName,
            pdfFiles: [fileBuffer],
          });
        } else if (isExcel) {
          await pythonRagService.ingestData({
            collectionName,
            excelFiles: [fileBuffer],
          });
        }
      }

      doc.status = 'ready';
      doc.updated_at_unix = Math.floor(Date.now() / 1000);
      await doc.save();
      console.log(`[KB Service] ✅ Doc ${doc.document_id} is ready`);
    } catch (error) {
      console.error(`[KB Service] ❌ Ingestion failed for doc ${doc.document_id}:`, error);
      doc.status = 'failed';
      doc.updated_at_unix = Math.floor(Date.now() / 1000);
      await doc.save();
    }
  }

  async findDocuments(userId: string, cursor?: string, pageSize = 30, organizationId?: string) {
    console.log(`[KB Service] findDocuments called for userId: ${userId}, cursor: ${cursor}, pageSize: ${pageSize}`);
    
    try {
      // First, get the user's document_ids from our database to filter Python API response
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const userDocs = await KnowledgeBaseDocument.find({ userId: userObjectId })
        .select('document_id')
        .lean();
      
      const userDocumentIds = userDocs.map((doc: any) => doc.document_id).filter(Boolean);
      
      console.log(`[KB Service] User has ${userDocumentIds.length} knowledge bases in database`);
      console.log(`[KB Service] User document_ids:`, userDocumentIds);

      if (userDocumentIds.length === 0) {
        // User has no knowledge bases, return empty result
        console.log(`[KB Service] User has no knowledge bases, returning empty result`);
        return {
          documents: [],
          cursor: null,
        };
      }

      // Call Python API to fetch knowledge bases
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/knowledge-base`;
      
      const params: any = {
        page_size: Math.min(Math.max(pageSize, 1), 100), // Ensure between 1 and 100
      };
      
      if (cursor) {
        params.cursor = cursor;
      }

      console.log(`[KB Service] Calling Python API: ${pythonUrl} with params:`, params);

      const response = await axios.get(pythonUrl, {
        params,
        timeout: 30000,
      });

      console.log(`[KB Service] Python API response received`);
      
      // Python API should return { documents: [...], cursor: ... }
      const pythonData = response.data;
      
      // Map Python API response to our format and FILTER by user's document_ids
      const allPythonDocs = (pythonData.documents || []).map((doc: any) => ({
        id: doc.document_id || doc.id,
        document_id: doc.document_id || doc.id,
        name: doc.name,
        type: doc.source_type,
        status: doc.status || 'ready',
        created_at_unix: doc.created_at_unix || Math.floor(Date.now() / 1000),
        folder_path: doc.folder_path || null,
      }));

      // Filter to only include documents that belong to this user
      const filteredDocuments = allPythonDocs.filter((doc: any) => 
        userDocumentIds.includes(doc.document_id)
      );

      console.log(`[KB Service] Python API returned ${allPythonDocs.length} documents, filtered to ${filteredDocuments.length} for user`);

      // Also get full details from our database for any missing fields or status updates
      const localDocs = await KnowledgeBaseDocument.find({ 
        userId: userObjectId,
        document_id: { $in: userDocumentIds }
      })
        .select('document_id linked_chatbot_kb_id name source_type status created_at_unix folder_path')
        .sort({ created_at_unix: -1 })
        .lean();

      // Fetch ChatbotKnowledgeBase collection_name for each linked doc (needed for chatbot config)
      const linkedChatbotKbIds = localDocs
        .map((d: any) => d.linked_chatbot_kb_id)
        .filter(Boolean);
      const chatbotKbMap = new Map<string, string>();
      if (linkedChatbotKbIds.length > 0) {
        const chatbotKBs = await ChatbotKnowledgeBase.find({
          kb_id: { $in: linkedChatbotKbIds },
          userId: userObjectId,
        })
          .select('kb_id collection_name')
          .lean();
        chatbotKBs.forEach((kb: any) => chatbotKbMap.set(kb.kb_id, kb.collection_name));
      }

      // Merge Python API results with local database entries
      // Use document_id as the key to avoid duplicates
      const docMap = new Map();
      
      // Add filtered Python API documents
      filteredDocuments.forEach((doc: any) => {
        docMap.set(doc.document_id, doc);
      });
      
      // Add/update with local database documents (for any missing fields or status updates)
      localDocs.forEach((doc: any) => {
        const collectionName = doc.linked_chatbot_kb_id
          ? chatbotKbMap.get(doc.linked_chatbot_kb_id)
          : undefined;
        const existingDoc = docMap.get(doc.document_id);
        if (existingDoc) {
          // Merge local status and collection_name (for chatbot config save)
          const coll = collectionName || existingDoc.collection_name;
          docMap.set(doc.document_id, {
            ...existingDoc,
            status: doc.status || existingDoc.status,
            collection_name: coll,
            collectionName: coll, // Frontend uses camelCase
          });
        } else {
          // Document exists in DB but not in Python API response
          docMap.set(doc.document_id, {
            id: doc.id,
            document_id: doc.document_id,
            name: doc.name,
            type: doc.source_type,
            status: doc.status,
            created_at_unix: doc.created_at_unix,
            folder_path: doc.folder_path,
            collection_name: collectionName,
            collectionName: collectionName, // Frontend uses camelCase
          });
        }
      });

      const allDocuments = Array.from(docMap.values())
        .sort((a: any, b: any) => (b.created_at_unix || 0) - (a.created_at_unix || 0));

      // Apply pagination
      let startIndex = 0;
      if (cursor) {
        const cursorIndex = allDocuments.findIndex((doc: any) => doc.document_id === cursor || doc.id === cursor);
        if (cursorIndex !== -1) {
          startIndex = cursorIndex + 1;
        }
      }

      const paginatedDocs = allDocuments.slice(startIndex, startIndex + pageSize);
      const nextCursor = paginatedDocs.length === pageSize 
        ? (paginatedDocs[paginatedDocs.length - 1].document_id || paginatedDocs[paginatedDocs.length - 1].id)
        : (pythonData.cursor || null);

      console.log(`[KB Service] Returning ${paginatedDocs.length} documents (total: ${allDocuments.length})`);

      return {
        documents: paginatedDocs,
        cursor: nextCursor,
      };
    } catch (error: any) {
      console.error('[KB Service] Failed to fetch knowledge bases from Python API:', error);
      
      // Fallback to database-only if Python API fails
      console.log('[KB Service] Falling back to database-only fetch...');
      
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const localDocs = await KnowledgeBaseDocument.find({ userId: userObjectId })
        .select('document_id linked_chatbot_kb_id name source_type status created_at_unix folder_path')
        .sort({ created_at_unix: -1 })
        .limit(pageSize)
        .lean();

      const linkedIds = localDocs.map((d: any) => d.linked_chatbot_kb_id).filter(Boolean);
      const chatbotKbMap = new Map<string, string>();
      if (linkedIds.length > 0) {
        const chatbotKBs = await ChatbotKnowledgeBase.find({
          kb_id: { $in: linkedIds },
          userId: userObjectId,
        })
          .select('kb_id collection_name')
          .lean();
        chatbotKBs.forEach((kb: any) => chatbotKbMap.set(kb.kb_id, kb.collection_name));
      }

      const coll = (d: any) => (d.linked_chatbot_kb_id ? chatbotKbMap.get(d.linked_chatbot_kb_id) : undefined);
      const documents = localDocs.map((doc: any) => {
        const c = coll(doc);
        return {
          id: doc.id,
          document_id: doc.document_id,
          name: doc.name,
          type: doc.source_type,
          status: doc.status,
          created_at_unix: doc.created_at_unix,
          folder_path: doc.folder_path,
          collection_name: c,
          collectionName: c, // Frontend uses camelCase
        };
      });

      return {
        documents,
        cursor: documents.length === pageSize ? documents[documents.length - 1].document_id : null,
      };
    }
  }

  async getDocument(document_id: string) {
    const doc = await KnowledgeBaseDocument.findOne({ document_id }).lean();
    if (!doc) {
      throw new AppError(404, 'NOT_FOUND', 'Document not found');
    }
    return {
      id: doc.id,
      document_id: doc.document_id,
      name: doc.name,
      type: doc.source_type,
      status: doc.status,
      created_at_unix: doc.created_at_unix,
    };
  }

  async deleteDocument(document_id: string) {
    // Try to delete from new KnowledgeBaseDocument
    let doc = await KnowledgeBaseDocument.findOne({ document_id });

    if (doc) {
      // 1. Delete linked ChatbotKnowledgeBase if exists
      if (doc.linked_chatbot_kb_id) {
        try {
          await ChatbotKnowledgeBase.deleteOne({ kb_id: doc.linked_chatbot_kb_id });
          console.log(`[KB Service] ✅ Deleted linked ChatbotKnowledgeBase: ${doc.linked_chatbot_kb_id}`);
        } catch (error: any) {
          console.error(`[KB Service] ⚠️  Failed to delete linked ChatbotKnowledgeBase:`, error.message);
        }
      }

      // 2. Remove DB record
      await KnowledgeBaseDocument.deleteOne({ document_id });

      // 3. Clean up Settings references
      try {
        const Settings = (await import('../models/Settings')).default;
        const settings = await Settings.findOne({ userId: doc.userId });
        if (settings) {
          // Remove from defaultKnowledgeBaseIds if present
          if (settings.defaultKnowledgeBaseIds) {
            const updatedIds = settings.defaultKnowledgeBaseIds.filter(
              (id: string) => id !== document_id && id !== doc.linked_chatbot_kb_id
            );
            await Settings.updateOne(
              { userId: doc.userId },
              { $set: { defaultKnowledgeBaseIds: updatedIds } }
            );
          }
          // Remove from knowledge_base_ids if present
          if (settings.knowledge_base_ids) {
            const updatedKbIds = settings.knowledge_base_ids.filter(
              (id: string) => id !== document_id && id !== doc.linked_chatbot_kb_id
            );
            await Settings.updateOne(
              { userId: doc.userId },
              { $set: { knowledge_base_ids: updatedKbIds } }
            );
          }
        }
      } catch (error: any) {
        console.error(`[KB Service] ⚠️  Failed to clean up Settings references:`, error.message);
      }

      // TODO: 4. Delete vectors from vector store (needs implementation)
      // TODO: 5. Remove file from storage (if file)
      // TODO: 6. Detach from all agents (needs implementation)

      return { success: true, message: `Document ${document_id} deleted successfully` };
    } else {
      // If not found in new, try to delete from legacy KnowledgeBase
      // The document_id from the frontend could be a legacy _id
      const kb = await KnowledgeBase.findById(document_id);
      if (!kb) {
        throw new AppError(404, 'NOT_FOUND', 'Document not found');
      }

      console.log(`[KB Service] Deleting legacy knowledge base: ${kb.name} (${kb.collectionName})`);

      // Delete collection from Python RAG system
      try {
        await pythonRagService.deleteCollection(kb.collectionName);
        console.log(`[KB Service] ✅ Collection deleted from Python RAG system`);
      } catch (error: any) {
        console.error(`[KB Service] ⚠️ Failed to delete collection from Python RAG:`, error.message);
        // Continue with MongoDB cleanup even if Python deletion fails
      }

      // Clean up Settings references before deleting KB
      const userId = kb.userId.toString();
      const collectionName = kb.collectionName;
      const kbObjectId = new mongoose.Types.ObjectId(document_id); // Use document_id as kbId

      try {
        const Settings = (await import('../models/Settings')).default;
        const settings = await Settings.findOne({ userId });

        if (settings) {
          // Remove from arrays
          const updatedNames = Array.isArray(settings.defaultKnowledgeBaseNames)
            ? settings.defaultKnowledgeBaseNames.filter((name: string) => name !== collectionName)
            : [];

          const updatedIds = Array.isArray(settings.defaultKnowledgeBaseIds)
            ? settings.defaultKnowledgeBaseIds.filter((id: any) => id.toString() !== document_id)
            : [];

          // Update Settings - remove KB references
          const updateData: any = {
            defaultKnowledgeBaseNames: updatedNames,
            defaultKnowledgeBaseIds: updatedIds
          };

          // If this was the default KB, clear default fields or set to next available
          if (settings.defaultKnowledgeBaseId?.toString() === document_id ||
              settings.defaultKnowledgeBaseName === collectionName) {
            // If there are other KBs, set the first one as default
            if (updatedNames.length > 0) {
              // Find the first remaining KB
              const remainingKB = await KnowledgeBase.findOne({
                userId: kb.userId,
                _id: { $ne: document_id }
              }).sort({ isDefault: -1, createdAt: -1 });

              if (remainingKB) {
                updateData.defaultKnowledgeBaseId = remainingKB._id;
                updateData.defaultKnowledgeBaseName = remainingKB.collectionName;
              } else {
                // No more KBs - clear default fields
                updateData.defaultKnowledgeBaseId = null;
                updateData.defaultKnowledgeBaseName = null;
              }
            } else {
              // No more KBs - clear default fields
              updateData.defaultKnowledgeBaseId = null;
              updateData.defaultKnowledgeBaseName = null;
            }
          }

          await Settings.updateOne({ userId }, { $set: updateData });
          console.log(`[KB Service] ✅ Cleaned up Settings references for deleted KB`);
        }
      } catch (error: any) {
        console.error(`[KB Service] ⚠️ Failed to clean up Settings references:`, error.message);
        // Continue with deletion even if cleanup fails
      }

      // Delete all associated data from MongoDB
      await Promise.all([
        FAQ.deleteMany({ knowledgeBaseId: document_id }),
        Website.deleteMany({ knowledgeBaseId: document_id }),
        File.deleteMany({ knowledgeBaseId: document_id }),
        KnowledgeBase.findByIdAndDelete(document_id)
      ]);

      console.log(`[KB Service] ✅ Legacy Knowledge base and all associated data deleted`);
      return { success: true, message: `Knowledge base ${document_id} deleted successfully` };
    }
  }
  // List all knowledge bases
  async findAll(userId: string) {
    const knowledgeBases = await KnowledgeBase.find({ userId }).sort({ createdAt: -1 }).lean();

    const kbWithCounts = await Promise.all(
      knowledgeBases.map(async (kb: any) => {
        const faqCount = await FAQ.countDocuments({ knowledgeBaseId: kb._id });
        const websiteCount = await Website.countDocuments({ knowledgeBaseId: kb._id });
        const fileCount = await File.countDocuments({ knowledgeBaseId: kb._id });

        return {
          ...kb,
          faqCount,
          websiteCount,
          fileCount
        };
      })
    );

    return kbWithCounts;
  }

  /**
   * Create a new knowledge base
   * 
   * This method:
   * 1. Creates a collection in Python RAG system
   * 2. Ingests data sources if provided (URLs, PDFs, Excel files) 
   * 3. Saves KB record to MongoDB with proper user reference
   * 4. Auto-links KB to user's Settings (enables chatbot, sets as default if first KB)
   * 5. Syncs with InboundAgentConfig for voice/call functionality
   */
  async create(name: string, userId: string, dataSources?: {
    urlLinks?: string[];
    pdfFiles?: Buffer[];
    excelFiles?: Buffer[];
  }) {
    try {
      // Validate inputs
      if (!name || typeof name !== 'string' || name.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Knowledge base name is required');
      }
      
      if (!userId || typeof userId !== 'string') {
        throw new AppError(400, 'VALIDATION_ERROR', 'User ID is required');
      }
      
      // Generate collection name from knowledge base name (sanitize for Python/Chroma)
      const collectionName = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
      
      console.log(`[KB Service] Creating knowledge base for user: ${userId}`);
      console.log(`[KB Service] Name: "${name}" → Collection: "${collectionName}"`);
      
      // Check if THIS USER already has a knowledge base with this collection name
      // Different users can have KBs with the same name/collection name
      const existingKB = await KnowledgeBase.findOne({ 
        userId: userId,
        collectionName: collectionName 
      });
      if (existingKB) {
        console.log(`[KB Service] ⚠️  User ${userId} already has a KB with collection name "${collectionName}"`);
        throw new AppError(
          409,
          'DUPLICATE_COLLECTION_NAME',
          `You already have a knowledge base named "${existingKB.name}" that uses the collection "${collectionName}". Please choose a different name.`
        );
      }
      
      // Step 1: Create collection and ingest data
      const hasUrlLinks = dataSources?.urlLinks && dataSources.urlLinks.length > 0;
      const hasPdfFiles = dataSources?.pdfFiles && dataSources.pdfFiles.length > 0;
      const hasExcelFiles = dataSources?.excelFiles && dataSources.excelFiles.length > 0;
      const hasDataSources = hasUrlLinks || hasPdfFiles || hasExcelFiles;
      
      if (hasDataSources) {
        console.log(`[KB Service] Creating collection with data ingestion`);
        console.log(`[KB Service] Data sources:`, {
          urlLinks: dataSources.urlLinks?.length || 0,
          pdfFiles: dataSources.pdfFiles?.length || 0,
          excelFiles: dataSources.excelFiles?.length || 0
        });
        
        // If URLs are provided, call both APIs simultaneously:
        // 1. RAG_API_URL/rag/data_ingestion (for chatbot usage)
        // 2. PYTHON_API_URL/api/v1/knowledge-base/ingest (for calling agents)
        if (hasUrlLinks) {
          console.log(`[KB Service] URLs detected - calling both RAG and Python APIs simultaneously`);
          
          const ragApiPromise = pythonRagService.ingestData({
            collectionName: collectionName,
            urlLinks: dataSources.urlLinks || [],
            pdfFiles: dataSources.pdfFiles || [],
            excelFiles: dataSources.excelFiles || []
          });
          
          // Call Python API for each URL (for calling agents)
          const pythonApiPromises = (dataSources.urlLinks || []).map(async (url: string) => {
            try {
              const FormData = require('form-data');
              const formData = new FormData();
              formData.append('source_type', 'url');
              formData.append('name', name);
              formData.append('parent_folder_id', '');
              formData.append('text', '');
              formData.append('url', url);
              formData.append('file', Buffer.from(''), { filename: '', contentType: 'application/octet-stream' });
              
              const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/knowledge-base/ingest`;
              console.log(`[KB Service] Calling Python API for URL: ${url}`);
              
              const response = await axios.post(pythonUrl, formData, {
                headers: formData.getHeaders(),
                timeout: 30000,
              });
              
              console.log(`[KB Service] ✅ Python API ingested URL: ${url}`);
              return response.data;
            } catch (error: any) {
              console.error(`[KB Service] ⚠️  Failed to ingest URL ${url} in Python API:`, error.response?.data || error.message);
              // Don't throw - continue with other URLs
              return null;
            }
          });
          
          // Execute both API calls in parallel
          const [ragResult, ...pythonResults] = await Promise.all([
            ragApiPromise,
            ...pythonApiPromises
          ]);
          
          console.log(`[KB Service] ✅ RAG API ingestion completed`);
          console.log(`[KB Service] ✅ Python API ingestion completed for ${pythonResults.filter(r => r !== null).length} URL(s)`);
        } else {
          // No URLs, only call RAG API (for PDFs/Excel files)
          await pythonRagService.ingestData({
            collectionName: collectionName,
            urlLinks: [],
            pdfFiles: dataSources.pdfFiles || [],
            excelFiles: dataSources.excelFiles || []
          });
          
          console.log(`[KB Service] ✅ Collection created and data ingested in Python RAG`);
        }
      } else {
        console.log(`[KB Service] Creating empty collection (no data sources)`);
        await pythonRagService.createCollection(collectionName);
        console.log(`[KB Service] ✅ Empty collection created in Python RAG`);
      }
      
      // Step 2: Save KB records to MongoDB (both collections)
      const nowUnix = Math.floor(Date.now() / 1000);
      const userIdObjectId = new mongoose.Types.ObjectId(userId);
      
      // Generate unique IDs for linking
      const chatbotKbId = `kb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Save legacy KnowledgeBase (for backward compatibility)
      const kb = await KnowledgeBase.create({ 
        userId,
        name,
        collectionName,
        isDefault: false // Will be updated below if first KB
      });
      
      console.log(`[KB Service] ✅ Legacy KB record saved to MongoDB: ${kb._id}`);
      
      // Save ChatbotKnowledgeBase (for chatbot usage)
      if (hasDataSources) {
        try {
          const chatbotKB = await ChatbotKnowledgeBase.create({
            kb_id: chatbotKbId,
            linked_kb_id: null, // Legacy KBs don't have voice agent KBs
            userId: userIdObjectId,
            name: name,
            collection_name: collectionName,
            source_type: hasUrlLinks ? 'url' : 'file',
            source_payload: {
              url: hasUrlLinks ? (dataSources.urlLinks || []).join(',') : undefined,
              file_name: hasPdfFiles || hasExcelFiles ? 'Multiple files' : undefined,
              file_type: hasPdfFiles ? 'application/pdf' : (hasExcelFiles ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : undefined),
            },
            status: 'ready',
            metadata: {
              legacy_kb_id: kb._id.toString(),
            },
            created_at_unix: nowUnix,
            updated_at_unix: nowUnix,
          });
          console.log(`[KB Service] ✅ ChatbotKnowledgeBase saved: ${chatbotKB.kb_id} (collection: ${collectionName})`);
        } catch (chatbotError: any) {
          console.error(`[KB Service] ⚠️  Failed to create ChatbotKnowledgeBase:`, chatbotError.message);
          // Don't throw - legacy KB was created successfully
        }
      }
      
      // Step 3: Auto-link KB to Settings
      await this.linkKBToSettings(userId, kb._id.toString(), collectionName);
      
      // Step 4: Sync with InboundAgentConfig for voice functionality
      try {
        const { inboundAgentConfigService } = await import('./inboundAgentConfig.service');
        await inboundAgentConfigService.syncConfig(userId);
        console.log(`[KB Service] ✅ InboundAgentConfig synced`);
      } catch (error: any) {
        console.warn(`[KB Service] ⚠️  Failed to sync InboundAgentConfig:`, error.message);
      }
      
      return kb;
    } catch (error: any) {
      console.error(`[KB Service] ❌ Failed to create knowledge base:`, error);
      throw new AppError(
        error.statusCode || 500,
        error.code || 'KB_CREATE_ERROR',
        error.message || 'Failed to create knowledge base'
      );
    }
  }

  /**
   * Link a ChatbotKnowledgeBase to user's settings
   * 
   * This ensures:
   * - autoReplyEnabled is set to true
   * - KB is added to defaultKnowledgeBaseNames array (no duplicates)
   * - KB ID is added to defaultKnowledgeBaseIds array (no duplicates)
   * - Legacy defaultKnowledgeBaseName is set (for backward compatibility)
   * - First KB becomes the default
   */
  private async linkChatbotKBToSettings(userId: string, kbId: string, collectionName: string): Promise<void> {
    try {
      const Settings = (await import('../models/Settings')).default;
      let settings = await Settings.findOne({ userId });
      
      if (settings) {
        // Get existing KB names array
        const existingNames = Array.isArray(settings.defaultKnowledgeBaseNames) 
          ? [...settings.defaultKnowledgeBaseNames] 
          : [];
        
        // Get existing KB IDs array
        const existingIds = Array.isArray(settings.defaultKnowledgeBaseIds) 
          ? [...settings.defaultKnowledgeBaseIds] 
          : [];
        
        // Add new KB if not already present
        const nameAlreadyLinked = existingNames.includes(collectionName);
        const idAlreadyLinked = existingIds.some((id: any) => id.toString() === kbId);
        
        if (!nameAlreadyLinked) {
          existingNames.push(collectionName);
        }
        
        if (!idAlreadyLinked) {
          existingIds.push(kbId);
        }
        
        // Determine if this is the first KB (should be default)
        const isFirstKB = existingNames.length === 1;
        
        // Update Settings
        const updateData: any = {
          autoReplyEnabled: true,
          defaultKnowledgeBaseNames: existingNames,
          defaultKnowledgeBaseIds: existingIds
        };
        
        // Set legacy single-value fields (for backward compatibility)
        if (isFirstKB || !settings.defaultKnowledgeBaseName) {
          updateData.defaultKnowledgeBaseName = collectionName;
          updateData.defaultKnowledgeBaseId = kbId;
        }
        
        await Settings.updateOne({ userId }, { $set: updateData });
        console.log(`[KB Service] ✅ Linked ChatbotKnowledgeBase ${kbId} (collection: ${collectionName}) to Settings`);
      } else {
        // Create new Settings if doesn't exist
        await Settings.create({
          userId,
          autoReplyEnabled: true,
          defaultKnowledgeBaseNames: [collectionName],
          defaultKnowledgeBaseIds: [kbId],
          defaultKnowledgeBaseName: collectionName,
          defaultKnowledgeBaseId: kbId
        });
        console.log(`[KB Service] ✅ Created new Settings and linked ChatbotKnowledgeBase ${kbId} (collection: ${collectionName})`);
      }
    } catch (error: any) {
      console.error(`[KB Service] ⚠️  Failed to link ChatbotKnowledgeBase to Settings:`, error.message);
      throw error;
    }
  }

  /**
   * Link a knowledge base to user's settings (legacy method for KnowledgeBase model)
   * 
   * This ensures:
   * - autoReplyEnabled is set to true
   * - KB is added to defaultKnowledgeBaseNames array (no duplicates)
   * - Legacy defaultKnowledgeBaseName is set (for backward compatibility)
   * - First KB becomes the default
   */
  private async linkKBToSettings(userId: string, kbId: string, collectionName: string): Promise<void> {
    try {
      const Settings = (await import('../models/Settings')).default;
      let settings = await Settings.findOne({ userId });
      
      if (settings) {
        // Get existing KB names array
        const existingNames = Array.isArray(settings.defaultKnowledgeBaseNames) 
          ? [...settings.defaultKnowledgeBaseNames] 
          : [];
        
        // Get existing KB IDs array
        const existingIds = Array.isArray(settings.defaultKnowledgeBaseIds) 
          ? [...settings.defaultKnowledgeBaseIds] 
          : [];
        
        // Add new KB if not already present
        const nameAlreadyLinked = existingNames.includes(collectionName);
        const idAlreadyLinked = existingIds.some((id: any) => id.toString() === kbId);
        
        if (!nameAlreadyLinked) {
          existingNames.push(collectionName);
        }
        
        if (!idAlreadyLinked) {
          existingIds.push(kbId); // kbId is already a string
        }
        
        // Determine if this is the first KB (should be default)
        const isFirstKB = existingNames.length === 1;
        
        // Update Settings
        const updateData: any = {
          autoReplyEnabled: true,
          defaultKnowledgeBaseNames: existingNames,
          defaultKnowledgeBaseIds: existingIds
        };
        
        // Set legacy single-value fields (for backward compatibility)
        if (isFirstKB || !settings.defaultKnowledgeBaseName) {
          updateData.defaultKnowledgeBaseName = collectionName;
          updateData.defaultKnowledgeBaseId = kbId;
        }
        
        await Settings.updateOne({ userId }, { $set: updateData });
        
        console.log(`[KB Service] ✅ Settings updated:`, {
          userId,
          collectionName,
          totalKBs: existingNames.length,
          isFirstKB,
          autoReplyEnabled: true
        });
      } else {
        // Create new Settings document
        await Settings.create({
          userId,
          autoReplyEnabled: true,
          defaultKnowledgeBaseId: new mongoose.Types.ObjectId(kbId),
          defaultKnowledgeBaseName: collectionName,
          defaultKnowledgeBaseIds: [new mongoose.Types.ObjectId(kbId)],
          defaultKnowledgeBaseNames: [collectionName]
        });
        
        console.log(`[KB Service] ✅ Created new Settings with KB linked:`, {
          userId,
          kbId,
          collectionName,
          defaultKnowledgeBaseNames: [collectionName],
          defaultKnowledgeBaseIds: [kbId]
        });
      }
    } catch (error: any) {
      console.error(`[KB Service] ⚠️  Failed to link KB to Settings:`, error.message);
      // Don't throw - KB creation should still succeed
    }
  }

  /**
   * Set a knowledge base as the default for a user
   * 
   * This updates:
   * - Settings.defaultKnowledgeBaseName (string)
   * - Settings.defaultKnowledgeBaseId (ObjectId)
   * - Moves the KB to the front of defaultKnowledgeBaseNames array
   */
  async setAsDefault(userId: string, kbId: string): Promise<void> {
    try {
      const kb = await KnowledgeBase.findById(kbId);
      if (!kb) {
        throw new AppError(404, 'NOT_FOUND', 'Knowledge base not found');
      }

      if (kb.userId.toString() !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have access to this knowledge base');
      }

      const Settings = (await import('../models/Settings')).default;
      const settings = await Settings.findOne({ userId });

      if (!settings) {
        // Create settings if doesn't exist
        await Settings.create({
          userId,
          autoReplyEnabled: true,
          defaultKnowledgeBaseId: kbId,
          defaultKnowledgeBaseName: kb.collectionName,
          defaultKnowledgeBaseIds: [kbId],
          defaultKnowledgeBaseNames: [kb.collectionName]
        });
      } else {
        // Get existing arrays
        const existingNames = Array.isArray(settings.defaultKnowledgeBaseNames)
          ? settings.defaultKnowledgeBaseNames.filter((n: string) => n !== kb.collectionName)
          : [];
        const existingIds = Array.isArray(settings.defaultKnowledgeBaseIds)
          ? settings.defaultKnowledgeBaseIds.filter((id: any) => id.toString() !== kbId)
          : [];

        // Put the selected KB at the front
        const newNames = [kb.collectionName, ...existingNames];
        const newIds = [kbId, ...existingIds];

        await Settings.updateOne(
          { userId },
          {
            $set: {
              defaultKnowledgeBaseId: kbId,
              defaultKnowledgeBaseName: kb.collectionName,
              defaultKnowledgeBaseIds: newIds,
              defaultKnowledgeBaseNames: newNames
            }
          }
        );
      }

      // Update KB model to mark as default
      await KnowledgeBase.updateMany({ userId }, { isDefault: false });
      await KnowledgeBase.updateOne({ _id: kbId }, { isDefault: true });

      console.log(`[KB Service] ✅ Set KB "${kb.name}" as default for user ${userId}`);

      // Sync InboundAgentConfig
      try {
        const { inboundAgentConfigService } = await import('./inboundAgentConfig.service');
        await inboundAgentConfigService.syncConfig(userId);
      } catch (error: any) {
        console.warn(`[KB Service] ⚠️  Failed to sync InboundAgentConfig:`, error.message);
      }
    } catch (error: any) {
      console.error(`[KB Service] ❌ Failed to set KB as default:`, error);
      throw error;
    }
  }

  /**
   * Get knowledge base collections for a user
   * Returns the collection names that should be used for RAG queries
   */
  async getCollectionNamesForUser(userId: string): Promise<string[]> {
    try {
      const Settings = (await import('../models/Settings')).default;
      const settings = await Settings.findOne({ userId });

      if (settings?.defaultKnowledgeBaseNames && settings.defaultKnowledgeBaseNames.length > 0) {
        return settings.defaultKnowledgeBaseNames;
      }

      if (settings?.defaultKnowledgeBaseName) {
        return [settings.defaultKnowledgeBaseName];
      }

      // Fallback: get all KBs for user
      const kbs = await KnowledgeBase.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
      return kbs.map((kb: any) => kb.collectionName);
    } catch (error: any) {
      console.error(`[KB Service] Error getting collection names:`, error);
      return [];
    }
  }

  // Delete knowledge base
  async delete(kbId: string) {
    try {
      const kb = await KnowledgeBase.findById(kbId);
      if (!kb) {
        throw new AppError(404, 'NOT_FOUND', 'Knowledge base not found');
      }

      console.log(`[KB Service] Deleting knowledge base: ${kb.name} (${kb.collectionName})`);

      // Delete collection from Python RAG system
      try {
        await pythonRagService.deleteCollection(kb.collectionName);
        console.log(`[KB Service] ✅ Collection deleted from Python RAG system`);
      } catch (error: any) {
        console.error(`[KB Service] ⚠️ Failed to delete collection from Python RAG:`, error.message);
        // Continue with MongoDB cleanup even if Python deletion fails
      }

      // Clean up Settings references before deleting KB
      const userId = kb.userId.toString();
      const collectionName = kb.collectionName;
      const kbObjectId = new mongoose.Types.ObjectId(kbId);
      
      try {
        const Settings = (await import('../models/Settings')).default;
        const settings = await Settings.findOne({ userId });
        
        if (settings) {
          // Remove from arrays
          const updatedNames = Array.isArray(settings.defaultKnowledgeBaseNames)
            ? settings.defaultKnowledgeBaseNames.filter((name: string) => name !== collectionName)
            : [];
          
          const updatedIds = Array.isArray(settings.defaultKnowledgeBaseIds)
            ? settings.defaultKnowledgeBaseIds.filter((id: any) => id.toString() !== kbId)
            : [];
          
          // Update Settings - remove KB references
          const updateData: any = {
            defaultKnowledgeBaseNames: updatedNames,
            defaultKnowledgeBaseIds: updatedIds
          };
          
          // If this was the default KB, clear default fields or set to next available
          if (settings.defaultKnowledgeBaseId?.toString() === kbId || 
              settings.defaultKnowledgeBaseName === collectionName) {
            // If there are other KBs, set the first one as default
            if (updatedNames.length > 0) {
              // Find the first remaining KB
              const remainingKB = await KnowledgeBase.findOne({
                userId: kb.userId,
                _id: { $ne: kbId }
              }).sort({ isDefault: -1, createdAt: -1 });
              
              if (remainingKB) {
                updateData.defaultKnowledgeBaseId = remainingKB._id;
                updateData.defaultKnowledgeBaseName = remainingKB.collectionName;
              } else {
                // No more KBs - clear default fields
                updateData.defaultKnowledgeBaseId = null;
                updateData.defaultKnowledgeBaseName = null;
              }
            } else {
              // No more KBs - clear default fields
              updateData.defaultKnowledgeBaseId = null;
              updateData.defaultKnowledgeBaseName = null;
            }
          }
          
          await Settings.updateOne({ userId }, { $set: updateData });
          console.log(`[KB Service] ✅ Cleaned up Settings references for deleted KB`);
        }
      } catch (error: any) {
        console.error(`[KB Service] ⚠️  Failed to clean up Settings references:`, error.message);
        // Continue with deletion even if cleanup fails
      }

      // Delete all associated data from MongoDB
      await Promise.all([
        FAQ.deleteMany({ knowledgeBaseId: kbId }),
        Website.deleteMany({ knowledgeBaseId: kbId }),
        File.deleteMany({ knowledgeBaseId: kbId }),
        KnowledgeBase.findByIdAndDelete(kbId)
      ]);

      console.log(`[KB Service] ✅ Knowledge base and all associated data deleted`);
      return { message: 'Knowledge base deleted successfully' };
    } catch (error: any) {
      console.error(`[KB Service] ❌ Failed to delete knowledge base:`, error);
      throw new AppError(
        error.statusCode || 500,
        error.code || 'KB_DELETE_ERROR',
        error.message || 'Failed to delete knowledge base'
      );
    }
  }

  // Get space usage
  async getSpaceUsage(kbId: string) {
    const kb = await KnowledgeBase.findById(kbId);
    if (!kb) {
      throw new AppError(404, 'NOT_FOUND', 'Knowledge base not found');
    }

    const files = await File.find({ knowledgeBaseId: kbId });
    const websites = await Website.find({ knowledgeBaseId: kbId });
    const faqs = await FAQ.find({ knowledgeBaseId: kbId });

    const filesSize = files.reduce((sum, file) => sum + file.size, 0);
    
    // Estimate website content size
    const websitesSize = websites.reduce((sum, website) => {
      const pagesSize = website.pages.reduce((pSum, page) => {
        return pSum + (page.content?.length || 0) * 2; // Rough estimate: 2 bytes per character
      }, 0);
      return sum + pagesSize;
    }, 0);

    // Estimate FAQs size
    const faqsSize = faqs.reduce((sum, faq) => {
      return sum + ((faq.question.length + faq.answer.length) * 2);
    }, 0);

    const total = 104857600; // 100 MB
    const used = filesSize + websitesSize + faqsSize;

    return {
      total,
      used,
      available: total - used,
      percentage: (used / total) * 100,
      breakdown: {
        faqs: faqsSize,
        websites: websitesSize,
        files: filesSize
      }
    };
  }

  // ===== FAQ Methods =====

  async findAllFAQs(kbId: string, page = 1, limit = 20, search?: string) {
    const query: any = { knowledgeBaseId: kbId };

    if (search) {
      query.$text = { $search: search };
    }

    const skip = (page - 1) * limit;
    const total = await FAQ.countDocuments(query);

    const faqs = await FAQ.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      items: faqs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  }

  async createFAQ(kbId: string, question: string, answer: string) {
    if (question.length > 300) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Question must be 300 characters or less');
    }

    if (answer.length > 1200) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Answer must be 1200 characters or less');
    }

    const faq = await FAQ.create({
      knowledgeBaseId: kbId,
      question,
      answer
    });

    // Ingest FAQ into Python RAG system
    try {
      const kb = await KnowledgeBase.findById(kbId);
      if (kb) {
        // Create a temporary text content for FAQ
        const faqContent = `Q: ${question}\nA: ${answer}`;
        console.log(`[KB Service] Ingesting FAQ into Python RAG for KB: ${kb.name}`);
        
        // Note: Python RAG doesn't have direct FAQ ingestion, so we'll add it as URL content
        // Alternatively, you can create a text file and upload it
        // For now, we'll log this and you may need to implement text content ingestion in Python
        console.log('[KB Service] FAQ created, manual ingestion may be required');
      }
    } catch (error: any) {
      console.error('[KB Service] Failed to ingest FAQ into RAG:', error);
      // Don't throw error - allow FAQ to be saved even if RAG ingestion fails
    }

    return faq;
  }

  async updateFAQ(faqId: string, question?: string, answer?: string) {
    const faq = await FAQ.findById(faqId);
    if (!faq) {
      throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
    }

    if (question) {
      if (question.length > 300) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Question must be 300 characters or less');
      }
      faq.question = question;
    }

    if (answer) {
      if (answer.length > 1200) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Answer must be 1200 characters or less');
      }
      faq.answer = answer;
    }

    await faq.save();
    return faq;
  }

  async deleteFAQ(faqId: string) {
    const faq = await FAQ.findByIdAndDelete(faqId);
    if (!faq) {
      throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
    }

    return { message: 'FAQ deleted successfully' };
  }

  async importFAQsFromCSV(kbId: string, csvContent: string) {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      const errors: any[] = [];

      Papa.parse(csvContent, {
        delimiter: ';',
        skipEmptyLines: true,
        complete: async (parseResult) => {
          const rows = parseResult.data as string[][];

          for (let i = 0; i < rows.length && i < 300; i++) {
            const row = rows[i];
            const question = row[0]?.trim();
            const answer = row[1]?.trim();

            if (!question || !answer) {
              errors.push({ row: i + 1, error: 'Missing question or answer' });
              continue;
            }

            if (question.length > 300) {
              errors.push({ row: i + 1, error: 'Question exceeds 300 characters' });
              continue;
            }

            if (answer.length > 1200) {
              errors.push({ row: i + 1, error: 'Answer exceeds 1200 characters' });
              continue;
            }

            try {
              await this.createFAQ(kbId, question, answer);
              results.push({ question, answer });
            } catch (error: any) {
              errors.push({ row: i + 1, error: error.message });
            }
          }

          resolve({
            imported: results.length,
            failed: errors.length,
            errors
          });
        },
        error: (error: any) => {
          reject(new AppError(400, 'VALIDATION_ERROR', `CSV parsing error: ${error.message}`));
        }
      });
    });
  }

  // ===== Website Methods =====

  async findAllWebsites(kbId: string) {
    const websites = await Website.find({ knowledgeBaseId: kbId })
      .sort({ createdAt: -1 })
      .lean();

    return websites;
  }

  async addWebsite(kbId: string, domain: string) {
    // Check if website already exists
    const existing = await Website.findOne({ knowledgeBaseId: kbId, domain });
    if (existing) {
      throw new AppError(409, 'DUPLICATE', 'Website already added');
    }

    const website = await Website.create({
      knowledgeBaseId: kbId,
      domain,
      pages: [],
      pagesCount: 0
    });

    return website;
  }

  async addWebsiteURLs(kbId: string, urls: string[]) {
    const websites = new Map<string, string[]>();

    // Group URLs by domain
    for (const url of urls) {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      if (!websites.has(domain)) {
        websites.set(domain, []);
      }
      websites.get(domain)!.push(url);
    }

    const results: any[] = [];

    for (const [domain, domainUrls] of websites.entries()) {
      let website = await Website.findOne({ knowledgeBaseId: kbId, domain });

      if (!website) {
        website = await Website.create({
          knowledgeBaseId: kbId,
          domain,
          pages: [],
          pagesCount: 0
        });
      }

      for (const url of domainUrls) {
        // Check if page already exists
        const pageExists = website.pages.some(p => p.url === url);
        if (!pageExists) {
          website.pages.push({
            url,
            title: '',
            content: '',
            status: 'pending'
          });
        }
      }

      website.pagesCount = website.pages.length;
      await website.save();

      results.push({
        websiteId: website._id,
        domain,
        addedUrls: domainUrls.length
      });
    }

    // Ingest URLs into Python RAG system
    try {
      console.log(`[KB Service] Ingesting ${urls.length} URLs into Python RAG`);
      await this.ingestIntoRAG(kbId, { urlLinks: urls });
    } catch (error: any) {
      console.error('[KB Service] Failed to ingest URLs into RAG:', error);
      // Don't throw error - allow the URLs to be saved even if RAG ingestion fails
    }

    return {
      added: urls.length,
      failed: 0,
      websites: results
    };
  }

  async deleteWebsite(websiteId: string) {
    const website = await Website.findByIdAndDelete(websiteId);
    if (!website) {
      throw new AppError(404, 'NOT_FOUND', 'Website not found');
    }

    return { message: 'Website deleted successfully' };
  }

  async deleteWebsitePage(websiteId: string, pageId: string) {
    const website = await Website.findById(websiteId);
    if (!website) {
      throw new AppError(404, 'NOT_FOUND', 'Website not found');
    }

    website.pages = website.pages.filter((p: any) => p._id.toString() !== pageId);
    website.pagesCount = website.pages.length;
    await website.save();

    return { message: 'Page deleted successfully' };
  }

  // ===== File Methods =====

  async findAllFiles(kbId: string) {
    const files = await File.find({ knowledgeBaseId: kbId })
      .sort({ uploadedAt: -1 })
      .lean();

    return files;
  }

  async createFileRecord(
    kbId: string,
    filename: string,
    originalFilename: string,
    fileType: string,
    size: number,
    url: string
  ) {
    const file = await File.create({
      knowledgeBaseId: kbId,
      filename,
      originalFilename,
      fileType,
      size,
      url,
      status: 'processing'
    });

    return file;
  }

  async updateFileContent(fileId: string, extractedContent: string, status: string) {
    const file = await File.findByIdAndUpdate(
      fileId,
      { extractedContent, status },
      { new: true }
    );

    return file;
  }

  async deleteFile(fileId: string) {
    const file = await File.findByIdAndDelete(fileId);
    if (!file) {
      throw new AppError(404, 'NOT_FOUND', 'File not found');
    }

    return { file, message: 'File deleted successfully' };
  }

  // ===== RAG Integration Methods =====

  /**
   * Ingest knowledge base data into Python RAG system
   * @param kbId Knowledge base ID
   * @param options Ingestion options (URLs, files)
   */
  async ingestIntoRAG(kbId: string, options: {
    urlLinks?: string[];
    pdfFiles?: Buffer[];
    excelFiles?: Buffer[];
  }) {
    try {
      const kb = await KnowledgeBase.findById(kbId);
      if (!kb) {
        throw new AppError(404, 'NOT_FOUND', 'Knowledge base not found');
      }

      console.log(`[KB Service] Ingesting data into Python RAG for KB: ${kb.name}`);

      // Use Python RAG service for data ingestion
      const result = await pythonRagService.ingestData({
        collectionName: kb.collectionName,
        ...options
      });

      console.log(`[KB Service] ✅ Data ingestion completed via Python RAG`);
      return result;
    } catch (error: any) {
      console.error(`[KB Service] ❌ Python RAG ingestion failed:`, error);
      throw error;
    }
  }

  /**
   * Get knowledge base by ID with collection name
   */
  async getKnowledgeBaseWithCollection(kbId: string) {
    const kb = await KnowledgeBase.findById(kbId);
    if (!kb) {
      throw new AppError(404, 'NOT_FOUND', 'Knowledge base not found');
    }
    return kb;
  }
}

export const knowledgeBaseService = new KnowledgeBaseService();

