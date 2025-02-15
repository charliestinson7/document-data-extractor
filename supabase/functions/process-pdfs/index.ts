
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'

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
    const formData = await req.formData()
    const files = formData.getAll('files')

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
        input_files: uploadedFiles
      })
      .select()
      .single()

    if (analysisError) throw analysisError

    // TODO: Add your Python script execution here
    // For now, we'll simulate processing
    setTimeout(async () => {
      const outputPath = `${analysis.id}/result.txt`
      
      // Simulate creating output file
      const { error: outputError } = await supabase.storage
        .from('outputs')
        .upload(outputPath, new Blob(['Processed PDF content would go here']), {
          contentType: 'text/plain',
          upsert: true
        })

      if (!outputError) {
        await supabase
          .from('pdf_analysis')
          .update({
            status: 'completed',
            output_file: outputPath
          })
          .eq('id', analysis.id)
      }
    }, 5000)

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
