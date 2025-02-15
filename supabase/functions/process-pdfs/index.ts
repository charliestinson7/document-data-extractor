
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'
import { PyPDF2 } from "npm:pypdf2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'No authorization header' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // Create Supabase client with auth context
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    // Verify the JWT token
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    const formData = await req.formData()
    const files = formData.getAll('files')

    if (!files || files.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files uploaded' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Upload files to pdfs bucket
    const uploadPromises = files.map(async (file: any) => {
      const fileName = file.name.replace(/[^\x00-\x7F]/g, '')
      const filePath = `${crypto.randomUUID()}-${fileName}`

      const { data, error: uploadError } = await supabase.storage
        .from('pdfs')
        .upload(filePath, file, {
          contentType: 'application/pdf',
          upsert: false
        })

      if (uploadError) throw uploadError

      return {
        originalName: fileName,
        path: filePath,
        size: file.size
      }
    })

    const uploadedFiles = await Promise.all(uploadPromises)

    // Create analysis record
    const { data: analysis, error: analysisError } = await supabase
      .from('pdf_analysis')
      .insert({
        status: 'processing',
        input_files: uploadedFiles,
        user_id: user.id // Add user_id to track ownership
      })
      .select()
      .single()

    if (analysisError) throw analysisError

    // Start background processing
    EdgeRuntime.waitUntil((async () => {
      try {
        // Process each PDF and collect results
        const processPromises = uploadedFiles.map(async (fileInfo) => {
          const { data: pdfData } = await supabase.storage
            .from('pdfs')
            .download(fileInfo.path)

          if (!pdfData) throw new Error(`Failed to download PDF: ${fileInfo.path}`)

          // Convert Blob to ArrayBuffer for PyPDF2
          const arrayBuffer = await pdfData.arrayBuffer()
          
          // Create a new PDF reader
          const reader = new PyPDF2.PdfReader(new Uint8Array(arrayBuffer))
          let url = null

          // Extract links from each page
          for (let pageNum = 0; pageNum < reader.numPages; pageNum++) {
            const page = reader.getPage(pageNum)
            const annotations = page.getAnnotations()
            
            for (const annot of annotations) {
              if (annot.url && annot.url.includes('comparador.cnmc.gob.es')) {
                url = annot.url
                break
              }
            }
            if (url) break
          }

          if (!url) return null

          // Parse the URL parameters
          const parsedUrl = new URL(url)
          const params = Object.fromEntries(parsedUrl.searchParams)

          return {
            cnmc_url: url,
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

        // Update analysis status
        await supabase
          .from('pdf_analysis')
          .update({
            status: 'completed',
            output_file: outputPath
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
          .eq('user_id', user.id) // Add user_id check for security
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
