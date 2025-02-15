
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getErrorMessage } from '@/utils/errorHandling';
import { toast } from '@/components/ui/use-toast';

interface Analysis {
  id: string;
  created_at: string | null;
  file_name: string;
  file_path: string;
  output_path: string | null;
  status: string;
  error: string | null;
  page_count: number | null;
  total_size: number | null;
}

export function useFileAnalysis() {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis | null>(null);

  const processFiles = async (files: File[]) => {
    if (files.length === 0) return;

    setProcessing(true);
    setProgress(0);

    try {
      console.log('Starting file processing...');

      const filePromises = files.map(async (file) => {
        const filePath = `${crypto.randomUUID()}-${file.name.replace(/[^\x00-\x7F]/g, '')}`;

        // Upload file to storage
        const { error: uploadError } = await supabase.storage
          .from('pdfs')
          .upload(filePath, file);

        if (uploadError) {
          throw new Error(`Failed to upload file: ${uploadError.message}`);
        }

        // Create analysis record
        const { data: analysis, error: dbError } = await supabase
          .from('pdf_analysis')
          .insert({
            file_name: file.name,
            file_path: filePath,
            status: 'pending',
            total_size: file.size
          })
          .select()
          .single();

        if (dbError) {
          throw new Error(`Failed to create analysis record: ${dbError.message}`);
        }

        return analysis;
      });

      const analysisResults = await Promise.all(filePromises);
      const firstAnalysis = analysisResults[0];
      setCurrentAnalysis(firstAnalysis);

      console.log('Files uploaded, calling process-pdfs function...');

      const { data: functionData, error: functionError } = await supabase.functions.invoke('process-pdfs', {
        body: { analysisIds: analysisResults.map(a => a.id) }
      });

      if (functionError) {
        console.error('Function invocation error:', functionError);
        toast({
          title: "Error",
          description: functionError.message || 'Failed to process files',
          variant: "destructive",
        });
        setProcessing(false);
        return;
      }

      console.log('Edge function response:', functionData);

      const pollingInterval = setInterval(async () => {
        try {
          console.log('Polling for analysis status...');
          const { data: dbAnalysis, error } = await supabase
            .from('pdf_analysis')
            .select('*')
            .eq('id', firstAnalysis.id)
            .single();

          if (error) {
            console.error('Polling error:', error);
            clearInterval(pollingInterval);
            setProcessing(false);
            toast({
              title: "Error",
              description: error.message || 'Failed to check analysis status',
              variant: "destructive",
            });
            return;
          }

          if (dbAnalysis) {
            console.log('Analysis status:', dbAnalysis.status);
            setCurrentAnalysis(dbAnalysis);

            if (dbAnalysis.status === 'completed') {
              clearInterval(pollingInterval);
              setProgress(100);
              setProcessing(false);
              toast({
                title: "Processing complete",
                description: `Successfully processed ${dbAnalysis.page_count || 0} pages.\nTotal size: ${(dbAnalysis.total_size / 1024 / 1024).toFixed(2)} MB`,
              });
            } else if (dbAnalysis.status === 'error') {
              clearInterval(pollingInterval);
              setProcessing(false);
              toast({
                title: "Error",
                description: dbAnalysis.error || 'Processing failed',
                variant: "destructive",
              });
            } else {
              setProgress(50);
            }
          }
        } catch (pollingError) {
          console.error('Polling iteration error:', pollingError);
          // Don't clear interval here, let it retry
        }
      }, 2000);

      // Cleanup function
      return () => clearInterval(pollingInterval);

    } catch (error) {
      console.error('Top-level error:', error);
      toast({
        title: "Error",
        description: getErrorMessage(error),
        variant: "destructive",
      });
      setProcessing(false);
    }
  };

  const downloadResults = async () => {
    if (!currentAnalysis?.output_path) return;

    try {
      console.log('Starting download...');
      const { data, error } = await supabase.storage
        .from('outputs')
        .download(currentAnalysis.output_path);

      if (error) {
        console.error('Download error:', error);
        toast({
          title: "Error",
          description: error.message || 'Failed to download results',
          variant: "destructive",
        });
        return;
      }

      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentAnalysis.file_name}-analysis.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Download started",
        description: "Your results are being downloaded",
      });
    } catch (error) {
      console.error('Download error:', error);
      toast({
        title: "Error",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  return {
    processing,
    progress,
    currentAnalysis,
    processFiles,
    downloadResults
  };
}
