
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'
import { PDFDocument } from "https://cdn.skypack.dev/pdf-lib?dts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { analysisIds } = await req.json();

    if (!analysisIds || analysisIds.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No analysis IDs provided' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    console.log('Processing analysis IDs:', analysisIds);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get analysis records
    const { data: analyses, error: analysesError } = await supabase
      .from('pdf_analysis')
      .select('*')
      .in('id', analysisIds);

    if (analysesError) {
      throw new Error(`Failed to fetch analyses: ${analysesError.message}`);
    }

    if (!analyses || analyses.length === 0) {
      throw new Error('No analyses found');
    }

    console.log('Found analyses:', analyses);

    // Process each analysis in the background
    EdgeRuntime.waitUntil((async () => {
      try {
        let processedFiles = 0;
        let failedFiles = 0;
        let skippedFiles = 0;
        let totalConsumption = 0;
        let totalAmount = 0;

        const processPromises = analyses.map(async (analysis) => {
          try {
            // Download PDF from storage
            const { data: pdfData, error: downloadError } = await supabase.storage
              .from('pdfs')
              .download(analysis.file_path);

            if (downloadError || !pdfData) {
              throw new Error(`Failed to download PDF: ${downloadError?.message || 'No data'}`);
            }

            console.log('Processing PDF:', analysis.file_name);

            const arrayBuffer = await pdfData.arrayBuffer();
            const pdfDoc = await PDFDocument.load(arrayBuffer);
            
            let cnmcUrl = null;
            let foundUrls = [];
            
            // Extract URLs from each page
            for (let i = 0; i < pdfDoc.getPageCount(); i++) {
              const page = pdfDoc.getPage(i);
              const annotations = page.node.lookup(page.node.get('Annots'), true);
              
              if (!annotations) continue;
              
              for (const annot of annotations.asArray()) {
                if (annot.get('Subtype')?.value === 'Link') {
                  const action = annot.get('A');
                  const uri = action?.get('URI')?.value;
                  if (uri) {
                    foundUrls.push(uri);
                    if (uri.includes('comparador.cnmc.gob.es')) {
                      cnmcUrl = uri;
                      break;
                    }
                  }
                }
              }
              if (cnmcUrl) break;
            }

            console.log('Found URLs:', foundUrls);

            if (!cnmcUrl) {
              console.log('No CNMC URL found in PDF:', analysis.file_name);
              skippedFiles++;
              throw new Error('No CNMC URL found in PDF');
            }

            console.log('Found CNMC URL:', cnmcUrl);

            // Parse URL parameters
            const url = new URL(cnmcUrl);
            const params = Object.fromEntries(url.searchParams);

            const results = {
              cnmc_url: cnmcUrl,
              postal_code: params.cp,
              contracted_power_p1: parseFloat(params.pP1 || '0'),
              contracted_power_p2: parseFloat(params.pP2 || '0'),
              max_power_p1: parseFloat(params.pmaxP1 || '0'),
              max_power_p2: parseFloat(params.pmaxP2 || '0'),
              consumption_p1: parseFloat(params.caP1 || '0'),
              consumption_p2: parseFloat(params.caP2 || '0'),
              consumption_p3: parseFloat(params.caP3 || '0'),
              contract_start_date: params.iniA,
              contract_end_date: params.finContrato,
              billing_start_date: params.iniF,
              billing_end_date: params.finF,
              invoice_date: params.fFact,
              power_cost: parseFloat(params.impPot || '0'),
              energy_cost: parseFloat(params.impEner || '0'),
              total_amount: parseFloat(params.imp || '0'),
              additional_services_cost: parseFloat(params.impSA || '0'),
              other_costs_with_tax: parseFloat(params.impOtrosConIE || '0'),
              other_costs_without_tax: parseFloat(params.impOtrosSinIE || '0'),
              discount: parseFloat(params.dto || '0'),
              power_rate_p1: parseFloat(params.prP1 || '0'),
              power_rate_p2: parseFloat(params.prP2 || '0'),
              energy_rate_p1: parseFloat(params.prE1 || '0'),
              energy_rate_p2: parseFloat(params.prE2 || '0'),
              energy_rate_p3: parseFloat(params.prE3 || '0'),
              cups: params.cups,
              tariff_code: params.tc,
              marketer_code: params.com,
              green_energy: params.verde === 'true',
              has_permanence: params.finPen !== '0000-00-00'
            };

            console.log('Parsed results:', results);

            // Update running totals
            totalConsumption += results.consumption_p1 + results.consumption_p2 + results.consumption_p3;
            totalAmount += results.total_amount;

            // Create CSV content
            const csvHeader = Object.keys(results).join(',');
            const csvRow = Object.values(results).map(value => 
              typeof value === 'string' ? `"${value}"` : value
            ).join(',');
            const csvContent = [csvHeader, csvRow].join('\n');

            // Upload results CSV
            const outputPath = `${analysis.id}/analysis_results.csv`;
            const { error: uploadError } = await supabase.storage
              .from('outputs')
              .upload(outputPath, new Blob([csvContent], { type: 'text/csv' }), {
                contentType: 'text/csv',
                upsert: true
              });

            if (uploadError) {
              throw uploadError;
            }

            console.log('Uploaded results for:', analysis.file_name);

            // Update analysis record with more detailed stats
            await supabase
              .from('pdf_analysis')
              .update({
                status: 'completed',
                output_path: outputPath,
                page_count: pdfDoc.getPageCount(),
                summary_stats: {
                  total_consumption: results.consumption_p1 + results.consumption_p2 + results.consumption_p3,
                  total_cost: results.total_amount,
                  billing_period: {
                    start: results.billing_start_date,
                    end: results.billing_end_date
                  },
                  consumption_details: {
                    p1: results.consumption_p1,
                    p2: results.consumption_p2,
                    p3: results.consumption_p3
                  },
                  power_details: {
                    contracted_p1: results.contracted_power_p1,
                    contracted_p2: results.contracted_power_p2,
                    max_p1: results.max_power_p1,
                    max_p2: results.max_power_p2
                  },
                  costs_breakdown: {
                    power: results.power_cost,
                    energy: results.energy_cost,
                    additional_services: results.additional_services_cost,
                    other_with_tax: results.other_costs_with_tax,
                    other_without_tax: results.other_costs_without_tax,
                    discount: results.discount
                  }
                }
              })
              .eq('id', analysis.id);

            processedFiles++;

          } catch (error) {
            console.error(`Error processing ${analysis.file_name}:`, error);
            failedFiles++;
            await supabase
              .from('pdf_analysis')
              .update({
                status: 'error',
                error: error.message,
                summary_stats: {
                  error_details: error.message,
                  processed_at: new Date().toISOString()
                }
              })
              .eq('id', analysis.id);
          }
        });

        await Promise.all(processPromises);

        // Log summary statistics
        console.log('\nProcessing Summary:');
        console.log(`Files processed successfully: ${processedFiles}`);
        console.log(`Files with errors: ${failedFiles}`);
        console.log(`Files without CNMC URL: ${skippedFiles}`);
        console.log(`Total consumption: ${totalConsumption.toFixed(2)} kWh`);
        console.log(`Total amount: ${totalAmount.toFixed(2)}€`);
        console.log(`Average cost per file: ${(totalAmount / processedFiles).toFixed(2)}€`);

      } catch (error) {
        console.error('Background processing error:', error);
      }
    })());

    return new Response(
      JSON.stringify({
        message: 'Processing started',
        analysisIds
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Error processing PDFs:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to process PDFs', details: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
