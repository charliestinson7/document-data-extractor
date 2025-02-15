
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
    const { files } = await req.json();

    if (!files || files.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files uploaded' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Convert base64 files to Blob and upload
    const uploadPromises = files.map(async (fileData: any) => {
      const binaryString = atob(fileData.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: fileData.type });
      const fileName = fileData.name.replace(/[^\x00-\x7F]/g, '')
      const filePath = `${crypto.randomUUID()}-${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('pdfs')
        .upload(filePath, blob, {
          contentType: 'application/pdf',
          upsert: false
        })

      if (uploadError) throw uploadError

      return {
        originalName: fileName,
        path: filePath,
        size: bytes.length
      }
    })

    const uploadedFiles = await Promise.all(uploadPromises)

    const { data: analysis, error: analysisError } = await supabase
      .from('pdf_analysis')
      .insert({
        status: 'processing',
        input_files: uploadedFiles
      })
      .select()
      .single()

    if (analysisError) throw analysisError

    // Process PDFs in background
    EdgeRuntime.waitUntil((async () => {
      try {
        const processPromises = uploadedFiles.map(async (fileInfo) => {
          const { data: pdfData } = await supabase.storage
            .from('pdfs')
            .download(fileInfo.path)

          if (!pdfData) throw new Error(`Failed to download PDF: ${fileInfo.path}`)

          const arrayBuffer = await pdfData.arrayBuffer()
          const pdfDoc = await PDFDocument.load(arrayBuffer)
          
          let cnmcUrl = null
          
          // Extract URLs from each page
          for (let i = 0; i < pdfDoc.getPageCount(); i++) {
            const page = pdfDoc.getPage(i)
            const annotations = page.node.lookup(page.node.get('Annots'), true)
            
            if (!annotations) continue
            
            for (const annot of annotations.asArray()) {
              if (annot.get('Subtype')?.value === 'Link') {
                const action = annot.get('A')
                const uri = action?.get('URI')?.value
                if (uri && uri.includes('comparador.cnmc.gob.es')) {
                  cnmcUrl = uri
                  break
                }
              }
            }
            if (cnmcUrl) break
          }

          if (!cnmcUrl) return null

          // Parse URL parameters
          const url = new URL(cnmcUrl)
          const params = Object.fromEntries(url.searchParams)

          return {
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
            has_permanence: params.finPen !== '0000-00-00',
            filename: fileInfo.originalName,
            filepath: fileInfo.path
          }
        })

        const results = (await Promise.all(processPromises)).filter(Boolean)

        if (results.length === 0) {
          throw new Error('No valid data could be extracted from the PDFs')
        }

        // Calculate summary statistics
        const summaryStats = {
          total_files_processed: results.length,
          total_consumption_p1: results.reduce((sum, r) => sum + r.consumption_p1, 0),
          total_amount: results.reduce((sum, r) => sum + r.total_amount, 0),
          average_monthly_cost: results.reduce((sum, r) => sum + r.total_amount, 0) / results.length,
          date_range: {
            start: results.reduce((min, r) => !min || r.billing_start_date < min ? r.billing_start_date : min, ''),
            end: results.reduce((max, r) => !max || r.billing_end_date > max ? r.billing_end_date : max, '')
          }
        }

        // Create CSV content
        const csvHeader = Object.keys(results[0]).join(',')
        const csvRows = results.map(row => 
          Object.values(row).map(value => 
            typeof value === 'string' ? `"${value}"` : value
          ).join(',')
        )
        const csvContent = [csvHeader, ...csvRows].join('\n')

        // Upload results
        const outputPath = `${analysis.id}/analysis_results.csv`
        const { error: outputError } = await supabase.storage
          .from('outputs')
          .upload(outputPath, new Blob([csvContent], { type: 'text/csv' }), {
            contentType: 'text/csv',
            upsert: true
          })

        if (outputError) throw outputError

        // Update analysis record with results
        await supabase
          .from('pdf_analysis')
          .update({
            status: 'completed',
            output_file: outputPath,
            summary_stats: summaryStats
          })
          .eq('id', analysis.id)

      } catch (error) {
        console.error('Processing error:', error)
        await supabase
          .from('pdf_analysis')
          .update({
            status: 'error',
            error: error.message
          })
          .eq('id', analysis.id)
      }
    })())

    return new Response(
      JSON.stringify({
        message: 'Files uploaded and processing started',
        analysisId: analysis.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Error processing PDFs:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to process PDFs', details: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
