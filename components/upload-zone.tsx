import { useRouter } from "next/router";

import { useCallback, useRef, useState } from "react";

import { useTeam } from "@/context/team-context";
import { DocumentStorageType } from "@prisma/client";
import {
  Upload as ArrowUpTrayIcon,
  File as DocumentIcon,
  FileText as DocumentTextIcon,
  FileSpreadsheetIcon,
  Image as PhotoIcon,
  Presentation as PresentationChartBarIcon,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { FileRejection, useDropzone } from "react-dropzone";
import { mutate } from "swr";

import { useAnalytics } from "@/lib/analytics";
import { createDocument } from "@/lib/documents/create-document";
import { resumableUpload } from "@/lib/files/tus-upload";
import { usePlan } from "@/lib/swr/use-billing";
import { CustomUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getSupportedContentType } from "@/lib/utils/get-content-type";
import { getPagesCount } from "@/lib/utils/get-page-number-count";

interface FileWithPath extends File {
  path?: string;
}

const fileSizeLimits: { [key: string]: number } = {
  "application/vnd.ms-excel": 100, // 30 MB
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 30, // 30 MB
  "text/csv": 30, // 30 MB
  "application/vnd.oasis.opendocument.spreadsheet": 30, // 30 MB
};

function fileIcon(fileType: string) {
  switch (fileType) {
    case "application/pdf":
      return <DocumentTextIcon className="mx-auto h-6 w-6" />;
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/jpg":
      return <PhotoIcon className="mx-auto h-6 w-6" />;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-powerpoint":
    case "application/msword":
      return <PresentationChartBarIcon className="mx-auto h-6 w-6" />;
    case "application/vnd.ms-excel":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "text/csv":
    case "application/vnd.oasis.opendocument.spreadsheet":
      return <FileSpreadsheetIcon className="mx-auto h-6 w-6" />;
    default:
      return <DocumentIcon className="mx-auto h-6 w-6" />;
  }
}

export default function UploadZone({
  children,
  onUploadStart,
  onUploadProgress,
  onUploadRejected,
  folderPathName,
  setUploads,
  setRejectedFiles,
  dataroomId,
}: {
  children: React.ReactNode;
  onUploadStart: (
    uploads: { fileName: string; progress: number; documentId?: string }[],
  ) => void;
  onUploadProgress: (
    index: number,
    progress: number,
    documentId?: string,
  ) => void;
  onUploadRejected: (rejected: { fileName: string; message: string }[]) => void;
  setUploads: React.Dispatch<
    React.SetStateAction<
      { fileName: string; progress: number; documentId?: string }[]
    >
  >;
  setRejectedFiles: React.Dispatch<
    React.SetStateAction<{ fileName: string; message: string }[]>
  >;
  folderPathName?: string;
  dataroomId?: string;
}) {
  const analytics = useAnalytics();
  const { plan, loading } = usePlan();
  const router = useRouter();
  const teamInfo = useTeam();
  const { data: session } = useSession();
  const maxSize = plan === "business" || plan === "datarooms" ? 250 : 30;
  const maxNumPages = plan === "business" || plan === "datarooms" ? 500 : 100;

  const [progress, setProgress] = useState<number>(0);
  const [showProgress, setShowProgress] = useState(false);
  const uploadProgress = useRef<number[]>([]);

  const onDrop = useCallback(
    (acceptedFiles: FileWithPath[]) => {
      const newUploads = acceptedFiles.map((file) => ({
        fileName: file.name,
        progress: 0,
      }));
      onUploadStart(newUploads);

      const uploadPromises = acceptedFiles.map(async (file, index) => {
        const path = (file as any).path || file.webkitRelativePath || file.name;
        let numPages = 1;
        if (file.type === "application/pdf") {
          const buffer = await file.arrayBuffer();
          numPages = await getPagesCount(buffer);

          if (numPages > maxNumPages) {
            setUploads((prev) =>
              prev.filter((upload) => upload.fileName !== file.name),
            );

            return setRejectedFiles((prev) => [
              {
                fileName: file.name,
                message: `File has too many pages (max. ${maxNumPages})`,
              },
              ...prev,
            ]);
          }
        }

        const { complete } = await resumableUpload({
          file, // File
          onProgress: (bytesUploaded, bytesTotal) => {
            uploadProgress.current[index] = (bytesUploaded / bytesTotal) * 100;
            onUploadProgress(
              index,
              Math.min(Math.round(uploadProgress.current[index]), 99),
            );

            const _progress = uploadProgress.current.reduce(
              (acc, progress) => acc + progress,
              0,
            );

            setProgress(Math.round(_progress / acceptedFiles.length));
          },
          onError: (error) => {
            setUploads((prev) =>
              prev.filter((upload) => upload.fileName !== file.name),
            );

            setRejectedFiles((prev) => [
              { fileName: file.name, message: "Error uploading file" },
              ...prev,
            ]);
          },
          ownerId: (session?.user as CustomUser).id,
          teamId: teamInfo?.currentTeam?.id as string,
          numPages,
          relativePath: path.substring(0, path.lastIndexOf("/")),
        });

        const uploadResult = await complete;

        const documentData = {
          key: uploadResult.id,
          contentType: getSupportedContentType(uploadResult.fileType)!,
          name: file.name,
          storageType: DocumentStorageType.S3_PATH,
          numPages: uploadResult.numPages,
        };
        const response = await createDocument({
          documentData,
          teamId: teamInfo?.currentTeam?.id as string,
          numPages: uploadResult.numPages,
          folderPathName: folderPathName,
        });

        // add the new document to the list
        mutate(`/api/teams/${teamInfo?.currentTeam?.id}/documents`);
        folderPathName &&
          mutate(
            `/api/teams/${teamInfo?.currentTeam?.id}/folders/documents/${folderPathName}`,
          );

        const document = await response.json();

        if (dataroomId) {
          try {
            const response = await fetch(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  documentId: document.id,
                  folderPathName: folderPathName,
                }),
              },
            );

            if (!response.ok) {
              const { message } = await response.json();
              console.error(
                "An error occurred while adding document to the dataroom: ",
                message,
              );
              return;
            }

            mutate(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
            );
            mutate(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/folders/documents/${folderPathName}`,
            );
          } catch (error) {
            console.error(
              "An error occurred while adding document to the dataroom: ",
              error,
            );
          }
        }

        // update progress to 100%
        onUploadProgress(index, 100, document.id);

        analytics.capture("Document Added", {
          documentId: document.id,
          name: document.name,
          numPages: document.numPages,
          path: router.asPath,
          type: document.type,
          teamId: teamInfo?.currentTeam?.id,
          bulkupload: true,
          dataroomId: dataroomId,
        });

        return document;
      });

      const documents = Promise.all(uploadPromises);
    },
    [onUploadStart, onUploadProgress],
  );

  const onDropRejected = useCallback(
    (rejectedFiles: FileRejection[]) => {
      const rejected = rejectedFiles.map(({ file, errors }) => {
        let message = "";
        if (errors.find(({ code }) => code === "file-too-large")) {
          message = `File size too big (max. ${maxSize} MB)`;
        } else if (errors.find(({ code }) => code === "file-invalid-type")) {
          message = "File type not supported";
        }
        return { fileName: file.name, message };
      });
      onUploadRejected(rejected);
    },
    [onUploadRejected, maxSize],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/pdf": [], // ".pdf"
      "application/vnd.ms-excel": [], // ".xls"
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [], // ".xlsx"
      "text/csv": [], // ".csv"
      "application/vnd.oasis.opendocument.spreadsheet": [], // ".ods"
    },
    multiple: true,
    maxSize: maxSize * 1024 * 1024, // 30 MB
    onDrop,
    onDropRejected,
  });

  return (
    <div
      {...getRootProps({ onClick: (evt) => evt.stopPropagation() })}
      className="relative h-full min-h-[(calc(100vh-350px))]"
    >
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 top-0 z-50",
          isDragActive ? "pointer-events-auto" : "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "-m-1 hidden h-full items-center justify-center border-dashed bg-gray-100 text-center dark:border-gray-300 dark:bg-gray-400",
            isDragActive && "flex",
          )}
        >
          <input
            {...getInputProps()}
            name="file"
            id="upload-multi-files-zone"
            className="sr-only"
          />

          <div className="mt-4 flex flex-col text-sm leading-6 text-gray-800">
            <span className="mx-auto">Drop your file(s) to upload here</span>
            <p className="text-xs leading-5 text-gray-800">
              {`Only *.pdf, *.xls, *.xlsx, *.csv, *.ods & ${maxSize} MB limit`}
            </p>
          </div>
        </div>
      </div>

      {children}
    </div>
  );
}
