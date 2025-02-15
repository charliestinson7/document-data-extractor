
import React, { useCallback, useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from '../components/ui/use-toast';
import { Progress } from '../components/ui/progress';
import { Button } from '../components/ui/button';
import { Upload, FileText, X, Download } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface FileWithPreview extends File {
  preview?: string;
}

interface Analysis {
  id: string;
  status: string;
  output_file: string | null;
}

const FileUpload = () => {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis | null>(null);

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
    if (files.length === 0) return;

    setProcessing(true);
    setProgress(0);

    try {
      const formData = new FormData();
      files.forEach(file => {
        formData.append('files', file);
      });

      const response = await fetch(
        'https://oknexztwmsdbpurjbtys.supabase.co/functions/v1/process-pdfs',
        {
          method: 'POST',
          body: formData,
          headers: {
            'Authorization': `Bearer ${supabase.auth.session()?.access_token}`
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to process files');
      }

      const { analysisId } = await response.json();
      
      // Start polling for status
      const interval = setInterval(async () => {
        const { data: analysis, error } = await supabase
          .from('pdf_analysis')
          .select('*')
          .eq('id', analysisId)
          .single();

        if (error) {
          clearInterval(interval);
          throw error;
        }

        if (analysis) {
          setCurrentAnalysis(analysis);
          
          if (analysis.status === 'completed') {
            clearInterval(interval);
            setProgress(100);
            setProcessing(false);
            toast({
              title: "Processing complete",
              description: "Your files have been analyzed successfully",
            });
          } else if (analysis.status === 'error') {
            clearInterval(interval);
            setProcessing(false);
            throw new Error(analysis.error || 'Processing failed');
          } else {
            // Update progress based on status
            setProgress(50); // You can implement more granular progress updates
          }
        }
      }, 2000);
    } catch (error) {
      console.error('Error processing files:', error);
      toast({
        title: "Error",
        description: "Failed to process files. Please try again.",
        variant: "destructive",
      });
      setProcessing(false);
    }
  };

  const downloadResults = async () => {
    if (!currentAnalysis?.output_file) return;

    try {
      const { data, error } = await supabase.storage
        .from('outputs')
        .download(currentAnalysis.output_file);

      if (error) throw error;

      // Create download link
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'analysis-result.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Download started",
        description: "Your results are being downloaded",
      });
    } catch (error) {
      console.error('Error downloading results:', error);
      toast({
        title: "Error",
        description: "Failed to download results. Please try again.",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    return () => {
      files.forEach(file => {
        if (file.preview) {
          URL.revokeObjectURL(file.preview);
        }
      });
    };
  }, [files]);

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
              {currentAnalysis?.output_file && (
                <Button
                  variant="outline"
                  className="flex items-center space-x-2"
                  onClick={downloadResults}
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
