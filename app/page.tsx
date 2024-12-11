// pages/index.tsx
"use client"
import { useEffect, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}


export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ppgData, setPpgData] = useState<number[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [heartRate, setHeartRate] = useState<number>(0);
  const [confidence, setConfidence] = useState<number>(0);
  const [valleys, setValleys] = useState<Valley[]>([]);


  const samplePoints = [
    { x: 0.2, y: 0.2 }, // top-left
    { x: 0.8, y: 0.2 }, // top-right
    { x: 0.5, y: 0.5 }, // center
    { x: 0.2, y: 0.8 }, // bottom-left
    { x: 0.8, y: 0.8 }, // bottom-right
  ];

  const startCamera = async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      // Enable flashlight if available
      const track = newStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities() as any; 

      if (capabilities.torch) {
        const constraints = {
          advanced: [{ torch: true }]
        } as { advanced: ExtendedMediaTrackConstraintSet[] };
        
        await track.applyConstraints(constraints);
      }
  

      setStream(newStream);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };
  interface Valley {
    timestamp: Date;  // Changed from number to Date
    value: number;
    index: number;
  }
// Add this function outside detectValleys
function calculateHRV(valleys: Valley[]): {
  sdnn: number,
  confidence: number
} {
  if (valleys.length < 2) return { sdnn: 0, confidence: 0 };

  // Calculate RR intervals in milliseconds
  const rrIntervals: number[] = [];
  for (let i = 1; i < valleys.length; i++) {
    const interval = valleys[i].timestamp.getTime() - valleys[i-1].timestamp.getTime();
    // Filter physiologically impossible intervals (250ms to 2000ms, or 30-240 bpm)
    if (interval >= 250 && interval <= 2000) {
      rrIntervals.push(interval);
    }
  }

  if (rrIntervals.length < 2) return { sdnn: 0, confidence: 0 };

  // Calculate mean RR interval
  const meanRR = rrIntervals.reduce((sum, rr) => sum + rr, 0) / rrIntervals.length;

  // Calculate SDNN
  const squaredDifferences = rrIntervals.map(rr => Math.pow(rr - meanRR, 2));
  const sdnn = Math.sqrt(
    squaredDifferences.reduce((sum, diff) => sum + diff, 0) / (rrIntervals.length - 1)
  );

  // Calculate confidence based on number of valid intervals and their consistency
  const minIntervals = 5; // Minimum intervals for reliable HRV
  const intervalConfidence = Math.min(
    100,
    (rrIntervals.length / minIntervals) * 100
  );

  // Calculate coefficient of variation for consistency measure
  const cv = (sdnn / meanRR) * 100;
  const consistencyConfidence = Math.max(0, 100 - cv);

  // Final confidence is average of interval and consistency confidence
  const confidence = Math.min(100, (intervalConfidence + consistencyConfidence) / 2);

  return {
    sdnn: Math.round(sdnn),
    confidence: Math.round(confidence)
  };
}

// Modify your component to include HRV state
const [hrv, setHRV] = useState<{ sdnn: number; confidence: number }>({ sdnn: 0, confidence: 0 });
  function detectValleys(signal: number[], fps: number = 30): Valley[] {
    const valleys: Valley[] = [];
    const minValleyDistance = 0.4; // Increased from 0.3 to 0.4 seconds (150 BPM max)
    let lastValleyTime = 0;

    // Increase window size for better smoothing
    const windowSize = 7; // Increased from 5
    const movingAvg = signal.map((val, idx, arr) => {
      const start = Math.max(0, idx - windowSize);
      const end = Math.min(arr.length, idx + windowSize + 1);
      const sum = arr.slice(start, end).reduce((a, b) => a + b, 0);
      return sum / (end - start);
    });
  
    // Increase noise threshold
    const noiseThreshold = 8; // Increased from 5
  
    for (let i = 2; i < signal.length - 2; i++) {
      const currentValue = signal[i];
      const currentTime = i / fps;
  
      // More strict valley detection criteria
      if (currentValue < signal[i - 1] && 
          currentValue < signal[i - 2] && 
          currentValue < signal[i + 1] && 
          currentValue < signal[i + 2] &&
          currentValue < movingAvg[i]) { // Added condition to be below moving average
        
        if (currentTime - lastValleyTime >= minValleyDistance) {
          const localAmplitude = Math.abs(currentValue - movingAvg[i]);
  
          if (localAmplitude > noiseThreshold) {
            valleys.push({
              timestamp: new Date(Date.now() - ((signal.length - i) / fps) * 1000),
              value: currentValue,
              index: i
            });
            lastValleyTime = currentTime;
          }
        }
      }
    }

    return valleys;
  }
  
  function calculateHeartRate(valleys: Valley[]): {
    bpm: number,
    confidence: number
  } {
    if (valleys.length < 2) return { bpm: 0, confidence: 0 };
  
    // Calculate intervals between valleys
    const intervals: number[] = [];
    for (let i = 1; i < valleys.length; i++) {
      intervals.push((valleys[i].timestamp.getTime() - valleys[i-1].timestamp.getTime()) / 1000);
    }
  
    // More strict interval filtering
    const validIntervals = intervals.filter(interval => 
      interval >= 0.4 && interval <= 1.5 // 40-150 BPM range
    );
  
    if (validIntervals.length === 0) return { bpm: 0, confidence: 0 };
  
    // Calculate median instead of mean for better robustness
    validIntervals.sort((a, b) => a - b);
    const median = validIntervals[Math.floor(validIntervals.length / 2)];
  
    // Calculate confidence based on interval consistency
    const mean = validIntervals.reduce((sum, val) => sum + val, 0) / validIntervals.length;
    const variance = validIntervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / validIntervals.length;
    const stdDev = Math.sqrt(variance);
    
    const coefficientOfVariation = (stdDev / mean) * 100;
    const confidence = Math.max(0, Math.min(100, 100 - coefficientOfVariation));
  
    // Convert to BPM using median
    const bpm = Math.round(60 / median);
    
    return { bpm, confidence };
  }

  const processFrame = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    let rSum = 0, gSum = 0, bSum = 0;
    
    // Sample from 5 points
    samplePoints.forEach(point => {
      const x = Math.floor(point.x * canvas.width);
      const y = Math.floor(point.y * canvas.height);
      const pixel = context.getImageData(x, y, 1, 1).data;
      rSum += pixel[0];
      gSum += pixel[1];
      bSum += pixel[2];

      // Visualize sampling points
      context.beginPath();
      context.arc(x, y, 5, 0, 2 * Math.PI);
      context.fillStyle = 'yellow';
      context.fill();
    });

    // Calculate PPG signal
    const ppgSignal = (3 * rSum - bSum - gSum) / samplePoints.length;
    
    setPpgData(prev => {
      const newData = [...prev.slice(-300), ppgSignal];
      const newValleys = detectValleys(newData);
      setValleys(newValleys);
      
      const { bpm, confidence } = calculateHeartRate(newValleys);
      setHeartRate(bpm);
      setConfidence(confidence);
      
      // Add HRV calculation
      const hrvValues = calculateHRV(newValleys);
      setHRV(hrvValues);
      
      return newData;
    });
  };

  useEffect(() => {
    let animationFrame: number;
    
    if (isRecording) {
      startCamera();
      const animate = () => {
        processFrame();
        animationFrame = requestAnimationFrame(animate);
      };
      animationFrame = requestAnimationFrame(animate);
    } else {
      stopCamera();
    }

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      stopCamera();
    };
  }, [isRecording]);

  const chartData = {
    labels: Array.from({ length: ppgData.length }, (_, i) => i.toString()),
    datasets: [
      
      {
        label: 'Valleys',
        data: ppgData.map((_, i) => 
          valleys.find(v => v.index === i)?.value || null
        ),
        pointBackgroundColor: 'red',
        pointRadius: 3,
        showLine: false
      },
      {
        label: 'PPG Signal',
        data: ppgData,
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.4,
        fill: true,
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        pointRadius: 0,
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    scales: {
      y: {
        beginAtZero: false
      }
    },
    animation: {
      duration: 0 // Disable animation for better performance
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 text-cyan-600 p-6">
      {/* Main Container */}
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl px-4 bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text text-transparent">
            HeartLen
          </h1>
          <button
            onClick={() => setIsRecording(!isRecording)}
            className={`p-3 rounded-lg text-sm transition-all duration-300 ${
              isRecording 
              ? 'bg-red-500 hover:bg-red-600 text-white' 
              : 'bg-cyan-500 hover:bg-cyan-600 text-white'
            }`}
          >
            {isRecording ? '■ STOP' : '● START'} RECORDING
          </button>
        </div>
  
        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left Column */}
          <div className="space-y-6">
            {/* Camera Feed */}
            <div className="relative">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="hidden"
              />
              <canvas 
                ref={canvasRef}
                className="w-full h-[20vh] bg-white rounded-xl border-2 border-cyan-500"
                width={1280}
                height={720}
              />
              {/* Overlay Elements */}
              <div className="absolute top-4 left-4 text-sm text-cyan-100">
                CAMERA FEED
              </div>
            </div>
  
            {/* Metrics Cards */}
            <div className="grid grid-cols-2 gap-4">
              {/* Heart Rate Card */}
              <div className=" p-6  bg-white  rounded-xl border-2 border-cyan-500 backdrop-blur">
                <div className="text-sm  text-cyan-600 mb-2">HEART RATE</div>
                <div className="text-5xl font-bold text-cyan-600">
                  {heartRate > 0 ? heartRate : '--'}<span className="text-sm ml-2">BPM</span>
                </div>
                <div className="mt-4">
                  <div className="text-sm text-cyan-600 mb-1">
                    Confidence: {confidence.toFixed(1)}%
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div 
                      className="bg-gradient-to-r from-cyan-500 to-purple-500 h-2 rounded-full transition-all duration-300" 
                      style={{ width: `${confidence}%` }}
                    />
                  </div>
                </div>
              </div>
  
              {/* HRV Card */}
              <div className=" p-6  bg-white rounded-xl border-2 border-purple-500 backdrop-blur">
                <div className="text-sm text-purple-600 mb-2">HRV</div>
                <div className="text-5xl font-bold text-purple-600">
                  {hrv.sdnn > 0 ? hrv.sdnn : '--'}<span className="text-sm ml-2">ms</span>
                </div>
                <div className="mt-4">
                  <div className="text-sm text-purple-600 mb-1">
                    Confidence: {hrv.confidence.toFixed(1)}%
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div 
                      className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-300" 
                      style={{ width: `${hrv.confidence}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
            <div className="p-2  bg-white rounded-xl border-2 border-cyan-500 ">
            <div className="text-sm text-cyan-600">PPG SIGNAL</div>
            <Line data={chartData} options={{
              ...chartOptions
            }} />
          </div>
        </div>
      </div>
    </div>
  );
  
}
