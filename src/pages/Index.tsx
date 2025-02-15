import { FC } from "react";
import FileUpload from "../components/FileUpload";

const Index: FC = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="container py-12">
        <div className="text-center mb-12 space-y-4">
          <h1 className="text-4xl font-medium tracking-tight animate-fade-in">
            PDF Document Analyzer
          </h1>
          <p className="text-secondary max-w-md mx-auto animate-fade-in">
            Upload up to 6 PDF files and receive detailed analysis of their contents
          </p>
        </div>
        <FileUpload />
      </div>
    </div>
  );
};

export default Index;
