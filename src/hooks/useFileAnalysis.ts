
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getErrorMessage } from '@/utils/errorHandling';
import { toast } from '@/components/ui/use-toast';
import { Json } from '@/integrations/supabase/types';

interface SummaryStats {
  total_files_processed: number;
  total_consumption_p1: number;
  total_amount: number;
  average_monthly_cost: number;
  date_range: {
    start: string;
    end: string;
  };
}

interface Analysis {
  id: string;
  created_at: string | null;
  updated_at: string | null;
  status: string;
  input_files: Json;
  output_file: string | null;
  error: string | null;
  summary_stats: SummaryStats | null;
}

interface DatabaseAnalysis {
  id: string;
  created_at: string | null;
  updated_at: string | null;
  status: string;
  input_files: Json;
  output_file: string | null;
  error: string | null;
  summary_stats: Json | null;
}

function isSummaryStats(data: Json): data is SummaryStats {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  
  const stats = data as Record<string, unknown>;
  return (
    typeof stats.total_files_processed === 'number' &&
    typeof stats.total_consumption_p1 === 'number' &&
    typeof stats.total_amount === 'number' &&
    typeof stats.average_monthly_cost === 'number' &&
    typeof stats.date_range === 'object' &&
    stats.date_range !== null &&
    !Array.isArray(stats.date_range) &&
    typeof (stats.date_range as any).start === 'string' &&
    typeof (stats.date_range as any).end === 'string'
  );
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
        return new Promise<{ name: string; type: string; content: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64content = reader.result as string;
            const base64 = base64content.split(',')[1];
            resolve({
              name: file.name,
              type: file.type,
              content: base64
            });
          };
          reader.onerror = (error) => {
            console.error('FileReader error:', error);
            reject(new Error('Failed to read file'));
          };
          reader.readAsDataURL(file);
        });
      });

      const processedFiles = await Promise.all(filePromises);
      console.log('Files converted to base64');

      const { data, error: functionError } = await supabase.functions.invoke('process-pdfs', {
        body: { files: processedFiles }
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

      console.log('Edge function response:', data);
      const { analysisId } = data;

      const pollingInterval = setInterval(async () => {
        try {
          console.log('Polling for analysis status...');
          const { data: dbAnalysis, error } = await supabase
            .from('pdf_analysis')
            .select('*')
            .eq('id', analysisId)
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
            
            // Safely convert database analysis to our type
            const typedAnalysis: Analysis = {
              ...dbAnalysis,
              summary_stats: dbAnalysis.summary_stats && isSummaryStats(dbAnalysis.summary_stats) 
                ? dbAnalysis.summary_stats 
                : null
            };
            
            setCurrentAnalysis(typedAnalysis);

            if (dbAnalysis.status === 'completed') {
              clearInterval(pollingInterval);
              setProgress(100);
              setProcessing(false);

              if (typedAnalysis.summary_stats) {
                const stats = typedAnalysis.summary_stats;
                toast({
                  title: "Processing complete",
                  description: `Successfully processed ${stats.total_files_processed} files.\nTotal consumption (P1): ${stats.total_consumption_p1.toFixed(2)} kWh\nTotal amount: ${stats.total_amount.toFixed(2)}€`,
                });
              } else {
                toast({
                  title: "Processing complete",
                  description: "Your files have been analyzed successfully. Click 'Download Results' to get your data.",
                });
              }
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
    if (!currentAnalysis?.output_file) return;

    try {
      console.log('Starting download...');
      const { data, error } = await supabase.storage
        .from('outputs')
        .download(currentAnalysis.output_file);

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
      a.download = 'analysis-results.csv';
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
