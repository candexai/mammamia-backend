import multer from 'multer';
import { AppError } from '../middleware/error.middleware';

const storage = multer.memoryStorage();

// File filter for knowledge base uploads (strict - only documents)
const fileFilter = (req: any, file: any, cb: any) => {
  const allowedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
    'text/plain',
    'text/tab-separated-values'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(400, 'INVALID_FILE_TYPE', 'Unsupported file type'), false);
  }
};

// File filter for conversation attachments (permissive - images, documents, etc.)
const attachmentFileFilter = (req: any, file: any, cb: any) => {
  // Allow images
  const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  // Allow documents
  const documentTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv'
  ];
  // Allow audio/video
  const mediaTypes = [
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
    'video/mp4', 'video/webm', 'video/ogg'
  ];
  // Allow archives
  const archiveTypes = [
    'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'
  ];

  const allAllowedTypes = [...imageTypes, ...documentTypes, ...mediaTypes, ...archiveTypes];

  if (allAllowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(400, 'INVALID_FILE_TYPE', `Unsupported file type: ${file.mimetype}`), false);
  }
};

// Multer for knowledge base uploads (strict)
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Multer for CSV contact imports (large files allowed)
export const csvUpload = multer({
  storage,
  fileFilter: (req: any, file: any, cb: any) => {
    // Only allow CSV files for contact imports
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'INVALID_FILE_TYPE', 'Only CSV files are allowed for contact imports'), false);
    }
  },
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB - supports 1M+ contacts
  }
});

// Multer for conversation attachments (permissive)
export const attachmentUpload = multer({
  storage,
  fileFilter: attachmentFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB for attachments
  }
});

// Multer for avatar/logo uploads (images only)
export const avatarUpload = multer({
  storage,
  fileFilter: (req: any, file: any, cb: any) => {
    const allowedImageTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml'
    ];

    if (allowedImageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, 'INVALID_FILE_TYPE', `Unsupported image type: ${file.mimetype}`), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB for avatars/logos
  }
});

