
import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from '../components/ui/use-toast';
import { Progress } from '../components/ui/progress';
import { Button } from '../components/ui/button';
import { Upload, FileText, X, Download } from 'lucide-react';

interface FileWithPreview extends File {
  preview?: string;
}

const FileUpload = () => {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 5) {
      toast({
        title: "Too many files",
        description: "Please upload a maximum of 5 files",
        variant: "destructive",
      });
      return;
    }

    if (acceptedFiles.some(file => file.type !== 'application/pdf')) {
      toast({
        title: "Invalid file type",
        description: "Please upload only PDF files",
        variant: "destructive",
      });
      return;
    }

    setFiles(acceptedFiles.map(file => 
      Object.assign(file, {
        preview: URL.createObjectURL(file)
      })
    ));
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    },
    maxFiles: 5,
  });

  const removeFile = (index: number) => {
    setFiles(files => {
      const newFiles = [...files];
      URL.revokeObjectURL(newFiles[index].preview!);
      newFiles.splice(index, 1);
      return newFiles;
    });
  };

  const processFiles = async () => {
    setProcessing(true);
    setProgress(0);
    
    // Simulate processing with progress
    const totalSteps = 100;
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= totalSteps) {
          clearInterval(interval);
          setProcessing(false);
          toast({
            title: "Processing complete",
            description: "Your files have been analyzed successfully",
          });
          return prev;
        }
        return prev + 1;
      });
    }, 50);
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-8 space-y-8 animate-fade-in">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200 ease-in-out
          ${isDragActive ? 'border-primary bg-accent/50' : 'border-border hover:border-primary/50'}`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-12 w-12 text-secondary mb-4" />
        <p className="text-lg font-medium">
          {isDragActive ? 'Drop the files here' : 'Drag & drop PDF files here'}
        </p>
        <p className="text-sm text-secondary mt-2">
          or click to select files (max 5 files)
        </p>
      </div>

      {files.length > 0 && (
        <div className="space-y-4 animate-slide-up">
          <div className="bg-accent rounded-lg p-4">
            <h3 className="font-medium mb-4">Selected Files ({files.length}/5)</h3>
            <div className="space-y-2">
              {files.map((file, index) => (
                <div key={index} className="flex items-center justify-between bg-background p-3 rounded">
                  <div className="flex items-center space-x-3">
                    <FileText className="h-5 w-5 text-secondary" />
                    <span className="text-sm truncate max-w-[200px]">{file.name}</span>
                  </div>
                  <button
                    onClick={() => removeFile(index)}
                    className="text-secondary hover:text-primary transition-colors"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {processing ? (
            <div className="space-y-2 animate-slide-down">
              <div className="flex justify-between text-sm">
                <span>Processing files...</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          ) : (
            <div className="flex space-x-4 animate-slide-down">
              <Button
                onClick={processFiles}
                className="flex-1"
                disabled={processing}
              >
                Process Files
              </Button>
              {progress === 100 && (
                <Button
                  variant="outline"
                  className="flex items-center space-x-2"
                  onClick={() => {
                    toast({
                      title: "Download started",
                      description: "Your results are being downloaded",
                    });
                  }}
                >
                  <Download className="h-4 w-4" />
                  <span>Download Results</span>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FileUpload;
