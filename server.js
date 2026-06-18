require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3001;

/*
|--------------------------------------------------------------------------
| PostgreSQL Connection
|--------------------------------------------------------------------------
*/

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect()
  .then(() => {
    console.log("✅ PostgreSQL Connected");
  })
  .catch(err => {
    console.error("❌ Database Error:", err);
  });


app.post("/login", async (req, res) => {

    try {

        console.log("LOGIN ROUTE HIT");

        const { username, password } = req.body;

        console.log("Username:", username);
        console.log("Password:", password);

        // Verify student exists
        const student = await pool.query(
            "SELECT * FROM students WHERE reg_number = $1",
            [password]
        );

        if (!student.rows[0]) {
            return res.json({
                success: false,
                message: "Invalid registration number"
            });
        }

        // Check if already started/completed
        const sessionCheck = await pool.query(
            "SELECT * FROM exam_sessions WHERE reg_number = $1",
            [password]
        );

        const existing = sessionCheck.rows[0];

        if (existing && existing.exam_completed) {
            return res.json({
                success: false,
                message: "You already completed this exam"
            });
        }

        if (existing && existing.exam_started) {
            return res.json({
                success: false,
                message: "Exam already started"
            });
        }

        // Create session
        const sessionId = require("uuid").v4();

        await pool.query(
            `INSERT INTO exam_sessions
             (reg_number, session_id, exam_started)
             VALUES ($1, $2, true)`,
            [password, sessionId]
        );

        res.json({
            success: true,
            sessionId
        });

    } catch (err) {

        console.error("LOGIN ERROR:", err);

        res.status(500).json({
            success: false,
            message: "Login failed"
        });

    }

});
    
/*
|--------------------------------------------------------------------------
| Results Folder
|--------------------------------------------------------------------------
*/

const resultsDir = path.join(__dirname, "results");

if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir);
}

/*
|--------------------------------------------------------------------------
| Course List
|--------------------------------------------------------------------------
*/

const COURSES = [
  "Computer Packages",
  "Agro Entrepreneurship",
  "Smartphone Literacy",
  "ICT Short Courses"
];

/*
|--------------------------------------------------------------------------
| Home Page
|--------------------------------------------------------------------------
*/
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/*
|--------------------------------------------------------------------------
| Get Courses
|--------------------------------------------------------------------------
*/

app.get("/courses", (req, res) => {
  res.json(COURSES);
});

/*
|--------------------------------------------------------------------------
| Get Units By Course
|--------------------------------------------------------------------------
*/

app.get("/units/:course", async (req, res) => {

  try {

    const course = decodeURIComponent(req.params.course);

    const result = await pool.query(
      `
      SELECT *
      FROM units
      WHERE course_name = $1
      ORDER BY unit_code
      `,
      [course]
    );

    res.json(result.rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to load units"
    });

  }

});

/*
-----------------------------------------------------------------------
Load Questions
-----------------------------------------------------------------------
*/
app.get("/questions/:course", async (req, res) => {

  try {

    const course =
      decodeURIComponent(req.params.course);

    const unitsResult =
      await pool.query(
        `
        SELECT DISTINCT unit_code
        FROM questions
        WHERE course_name = $1
        ORDER BY unit_code
        `,
        [course]
      );

    let examQuestions = [];

    for (const unit of unitsResult.rows) {

      for (let group = 1; group <= 4; group++) {

        const result =
          await pool.query(
            `
            SELECT *
            FROM questions
            WHERE unit_code = $1
            AND question_group = $2
            ORDER BY RANDOM()
            LIMIT 1
            `,
            [unit.unit_code, group]
          );

        if (result.rows.length > 0) {
          examQuestions.push(result.rows[0]);
        }
      }
    }

    examQuestions.sort(
      () => Math.random() - 0.5
    );

    console.log(
      "Questions Returned:",
      examQuestions.length
    );

    res.json(examQuestions);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to load questions"
    });

  }

});
/*
|--------------------------------------------------------------------------
| Database Test
|--------------------------------------------------------------------------
*/

app.get("/db-test", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT NOW()"
    );

    res.json({
      connected: true,
      serverTime: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      connected: false,
      error: error.message
    });

  }

});

/*
|--------------------------------------------------------------------------
| Grade Calculation
|--------------------------------------------------------------------------
*/

function calculateGrade(score) {

  if (score >= 48) {
    return {
      grade: "DISTINCTION",
      remarks:
        "Excellent performance. Candidate demonstrated outstanding mastery of the course content."
    };
  }

  if (score >= 39) {
    return {
      grade: "CREDIT",
      remarks:
        "Very good performance. Candidate demonstrated a strong understanding of the course content."
    };
  }

  if (score >= 30) {
    return {
      grade: "PASS",
      remarks:
        "Satisfactory performance. Candidate met the minimum requirements."
    };
  }

  return {
    grade: "FAIL",
    remarks:
      "Candidate did not meet the minimum requirements and is advised to retake the assessment."
  };
}

/*
|--------------------------------------------------------------------------
| Unit Award
|--------------------------------------------------------------------------
*/

function calculateUnitAward(score) {

  if (score >= 10) return "DISTINCTION";
  if (score >= 8) return "CREDIT";
  if (score >= 6) return "PASS";

  return "FAIL";
}

/*
|--------------------------------------------------------------------------
| Generate PDF Result Slip
|--------------------------------------------------------------------------
*/
      function generatePDF(data) {
  return new Promise(async (resolve, reject) => {

    try {

      const verifyUrl =
  `https://gdehexm.onrender.com/verify/${student.reg_number}`;

      const qrDataUrl =
        await QRCode.toDataURL(verifyUrl);

      const qrBuffer = Buffer.from(
        qrDataUrl.replace(
          /^data:image\/png;base64,/,
          ""
        ),
        "base64"
      );

      
      const filename = `${data.regNumber}_${Date.now()}.pdf`;
      const filepath = path.join(resultsDir, filename);
      

      const doc = new PDFDocument({
        margin: 40,
        size: "A4"
      });

      const stream = fs.createWriteStream(filepath);
      doc.pipe(stream);
      


      const logoPath = path.join(__dirname, "gdeh_logo.png");

      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 240, 20, { width: 100 });
      }

      doc.moveDown(5);

      doc
        .fillColor("#001f54")
        .fontSize(16)
        .text("GARISSA DIGITAL EMPOWERMENT HUB CBO", { align: "center" });

      doc
        .fontSize(13)
        .text("END OF TRAINING EXAM", { align: "center" });

      doc.moveDown();

      doc.fontSize(10)
        .text("Along Kismayu RD off Rubis Energy opp Horizon High School", { align: "center" })
        .text("P.O BOX 10 70100 Garissa", { align: "center" });

      doc.moveDown();

      doc
        .fontSize(14)
        .text(`${data.course.toUpperCase()} RESULT SLIP`, { align: "center" })
        .fontSize(12)
        .text("YEAR 2026", { align: "center" });

      doc.moveDown(2);

      doc.fontSize(11);
      doc.text(`Name of Student: ${data.studentName}`);
      doc.text(`Reg Number: ${data.regNumber}`);
      doc.text(`Date: ${new Date().toLocaleDateString()}`);

      doc.moveDown();

      let y = doc.y;

      doc.text("Unit Name", 40, y);
      doc.text("Code", 220, y);
      doc.text("Hours", 280, y);
      doc.text("Score", 340, y);
      doc.text("Award", 420, y);

      y += 20;

      doc.moveTo(40, y).lineTo(550, y).stroke();
      y += 10;

      data.unitResults.forEach(unit => {
        doc.text(unit.unit_name, 40, y, { width: 160 });
        doc.text(unit.unit_code, 220, y);
        doc.text("12", 280, y);
        doc.text(`${unit.score}/12`, 340, y);
        doc.text(unit.award, 420, y);

        y += 25;
      });

      doc.moveDown(2);

      doc.text(`Total Marks: ${data.totalScore}/60`);
      doc.text(`Percentage: ${data.percentage}%`);
      doc.text(`Grade: ${data.grade}`);

      doc.moveDown();

      doc
        .fillColor("red")
        .fontSize(11)
        .text(`Remarks: ${data.remarks || ""}`);

      doc.fillColor("black");

      doc.moveDown(2);
/*
------------------------------------------------
QR Code Verification
------------------------------------------------
*/

const qrX = 260;
const qrY = 600;
const qrSize = 70;

doc.image(
  qrBuffer,
  qrX,
  qrY,
  {
    width: qrSize
  }
);

doc
  .font("Helvetica-Bold")
  .fontSize(8)
  .fillColor("black")
  .text(
    "Scan to Verify This Result Slip",
    qrX - 15,
    qrY + qrSize + 5,
    {
      width: 100,
      align: "center"
    }
  );

/*
------------------------------------------------
Signature
------------------------------------------------
*/

const signPath = path.join(
  __dirname,
  "signature.jpg"
);

const signY = 630;

doc
  .font("Helvetica")
  .fontSize(10)
  .fillColor("black")
  .text(
    "Authorizing Signature",
    50,
    signY
  );

if (fs.existsSync(signPath)) {

  doc.image(
    signPath,
    50,
    signY + 15,
    {
      width: 100
    }
  );

}

doc
  .font("Helvetica-Bold")
  .fontSize(10)
  .text(
    "Abdullahi Sheikh Aden",
    50,
    signY + 80
  );

doc
  .font("Helvetica")
  .fontSize(10)
  .text(
    "Programme Coordinator",
    50,
    signY + 95
  );

/*
------------------------------------------------
Note
------------------------------------------------
*/

doc
  .font("Helvetica")
  .fontSize(10)
  .fillColor("red")
  .text(
    "N/B: This is a computer generated result slip and is valid without stamp.",
    0,
    755,
    {
      align: "center"
    }
  );

/*
------------------------------------------------
Footer
------------------------------------------------
*/

doc
  .font("Helvetica")
  .fontSize(11)
  .fillColor("#0B1F4D")
  .text(
    "© GDEH CBO EXAMS All Rights Reserved",
    0,
    780,
    {
      align: "center"
    }
  );
      doc.end();

      stream.on("finish", () => {
        resolve(filename);
      });

    } catch (error) {

      reject(error);

    }

  });

}

/*
|--------------------------------------------------------------------------
| Submit Exam
|--------------------------------------------------------------------------
*/

app.post("/submit", async (req, res) => {

  try {

    const {
      studentName,
      regNumber,
      course,
      answers,
      sessionId   // ✅ ADD THIS (IMPORTANT)
    } = req.body;

    if (!studentName || !regNumber || !course || !sessionId) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    /*
    ------------------------------------------------
    VERIFY SESSION (NEW SECURITY LAYER)
    ------------------------------------------------
    */

    const sessionCheck = await pool.query(
      `
      SELECT *
      FROM exam_sessions
      WHERE session_id = $1
      AND reg_number = $2
      `,
      [sessionId, regNumber]
    );

    const session = sessionCheck.rows[0];

    if (!session) {
      return res.status(401).json({
        error: "Invalid or expired session"
      });
    }

    if (session.exam_completed) {
      return res.status(403).json({
        error: "You already submitted this exam"
      });
    }
    
    /*
-----------------------------------------------------------------------
Load Exam Questions
20 Questions Total
4 Questions Per Unit
1 Question From Each Group Of 3
-----------------------------------------------------------------------
*/

app.get("/questions/:course", async (req, res) => {

  try {

    const course =
      decodeURIComponent(
        req.params.course
      );

    const unitsResult =
      await pool.query(
        `
        SELECT DISTINCT unit_code
        FROM questions
        WHERE course_name = $1
        ORDER BY unit_code
        `,
        [course]
      );

    let questions = [];

    for (const unit of unitsResult.rows) {

      const result =
        await pool.query(
          `
          SELECT *
          FROM questions
          WHERE unit_code = $1
          ORDER BY id
          `,
          [unit.unit_code]
        );

      const rows = result.rows;

      if (rows.length < 12) {
        continue;
      }

      // Group 1 (Questions 1-3)
      questions.push(
        rows[Math.floor(Math.random() * 3)]
      );

      // Group 2 (Questions 4-6)
      questions.push(
        rows[3 + Math.floor(Math.random() * 3)]
      );

      // Group 3 (Questions 7-9)
      questions.push(
        rows[6 + Math.floor(Math.random() * 3)]
      );

      // Group 4 (Questions 10-12)
      questions.push(
        rows[9 + Math.floor(Math.random() * 3)]
      );

    }

    // Shuffle all 20 questions

    questions.sort(
      () => Math.random() - 0.5
    );

    res.json(questions);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to load questions"
    });

  }

});
 
  /*
------------------------------------------------
Load Submitted Questions
------------------------------------------------
*/

const questionIds =
  Object.keys(answers).map(Number);

const questionsResult =
  await pool.query(
    `
    SELECT *
    FROM questions
    WHERE id = ANY($1::int[])
    `,
    [questionIds]
  );

const questions =
  questionsResult.rows;

let totalScore = 0;

const unitScores = {};      
    
/*
------------------------------------------------
Mark Questions
------------------------------------------------
*/

    questions.forEach(q => {

      if (!unitScores[q.unit_code]) {

        unitScores[q.unit_code] = {
          unit_code: q.unit_code,
          unit_name: q.unit_name,
          score: 0
        };

      }

      const studentAnswer =
        answers[q.id];

      if (
        studentAnswer ===
        q.correct_answer
      ) {

        totalScore += q.marks;

        unitScores[q.unit_code]
          .score += q.marks;
      }

    });

    /*
    ------------------------------------------------
    Percentage
    ------------------------------------------------
    */

    const percentage =
      (
        (totalScore / 60) * 100
      ).toFixed(2);

    /*
    ------------------------------------------------
    Grade
    ------------------------------------------------
    */

    const gradeInfo =
      calculateGrade(totalScore);

    /*
    ------------------------------------------------
    Unit Results
    ------------------------------------------------
    */

    const unitResults =
      Object.values(unitScores)
      .map(unit => {

        return {

          unit_code:
            unit.unit_code,

          unit_name:
            unit.unit_name,

          score:
            unit.score,

          award:
            calculateUnitAward(
              unit.score
            )

        };

      });

    /*
    ------------------------------------------------
    Student Record
    ------------------------------------------------
    */

    let studentId;

    const existingStudent =
      await pool.query(
        `
        SELECT id
        FROM students
        WHERE reg_number = $1
        `,
        [regNumber]
      );

    if (
      existingStudent.rows.length > 0
    ) {

      studentId =
        existingStudent.rows[0].id;

    } else {

      const studentInsert =
        await pool.query(
          `
          INSERT INTO students
          (
            student_name,
            reg_number,
            course_name
          )
          VALUES
          ($1,$2,$3)
          RETURNING id
          `,
          [
            studentName,
            regNumber,
            course
          ]
        );

      studentId =
        studentInsert.rows[0].id;
    }

    /*
    ------------------------------------------------
    Generate PDF
    ------------------------------------------------
    */
    const pdfFile =
      await generatePDF({

        studentName,

        regNumber,

        course,

        totalScore,

        percentage,

        grade:
          gradeInfo.grade,

        remarks:
          gradeInfo.remarks,

        unitResults

      });

    /*
    ------------------------------------------------
    Save Attempt
    ------------------------------------------------
    */

    const attempt =
      await pool.query(
        `
        INSERT INTO exam_attempts
        (
          student_id,
          course_name,
          total_score,
          percentage,
          grade,
          remarks,
          pdf_file
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
        `,
        [
          studentId,
          course,
          totalScore,
          percentage,
          gradeInfo.grade,
          gradeInfo.remarks,
          pdfFile
        ]
      );

    const attemptId =
      attempt.rows[0].id;

    /*
    ------------------------------------------------
    Save Unit Results
    ------------------------------------------------
    */

    for (
      const unit of unitResults
    ) {

      await pool.query(
        `
        INSERT INTO result_details
        (
          attempt_id,
          unit_code,
          unit_name,
          score,
          award
        )
        VALUES
        ($1,$2,$3,$4,$5)
        `,
        [
          attemptId,
          unit.unit_code,
          unit.unit_name,
          unit.score,
          unit.award
        ]
      );

    }

    /*
    ------------------------------------------------
    Response
    ------------------------------------------------
    */

    res.json({

      success: true,

      totalScore,

      percentage,

      grade:
        gradeInfo.grade,

      remarks:
        gradeInfo.remarks,
       regNumber,       

      pdf:
        `/download/${pdfFile}`

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});

/*
|--------------------------------------------------------------------------
| Download Result Slip
|--------------------------------------------------------------------------
*/

app.get(
  "/download/:file",
  (req, res) => {

    const file =
      path.join(
        resultsDir,
        req.params.file
      );

    if (
      !fs.existsSync(file)
    ) {

      return res
      .status(404)
      .send("File not found");

    }

    res.download(file);

  }
);

app.get("/verify/:regNumber", async (req, res) => {
  try {

    const { regNumber } = req.params;

    const result = await pool.query(
      `SELECT * FROM students WHERE reg_number = $1`,
      [regNumber]
    );

    if (result.rows.length === 0) {
      return res.send("<h2>Student not found</h2>");
    }

    const student = result.rows[0];

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>GDEH Verification Portal</title>
  
          
       <style>

body{
  font-family: Arial, sans-serif;
  text-align: center;
  padding: 30px;
  background: white;
  color: #0B1F4D;
}

img{
  width: 120px;
}

.card{
  max-width: 700px;
  margin: auto;
  background: white;
  border: 2px solid #0B1F4D;
  padding: 20px;
  border-radius: 10px;
}

h1,
h2,
p,
footer{
  color: #0B1F4D;
}

.verify{
  color: green;
  font-weight: bold;
  font-size: 18px;
}

</style>

      </head>
      <body>

        <img src="/gdeh_logo.png" alt="GDEH Logo">

        <h1>GARISSA DIGITAL EMPOWERMENT HUB CBO</h1>

        <p>
          Along Kismayu RD off Rubis Energy opp Horizon High School<br>
          P.O Box 10-70100, Garissa
        </p>

        <div class="card">

          <h2>Result Verification</h2>

          <p><strong>Name:</strong> ${student.student_name}</p>

          <p><strong>Reg Number:</strong> ${student.reg_number}</p>

          <p><strong>Course:</strong> ${student.course_name}</p>

          <p><strong>Status:</strong> VERIFIED ✓</p>

        </div>

        <br>

        <footer>
          © GDEH CBO Verification Portal. All Rights Reserved.
        </footer>

      </body>
      </html>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send("Verification Error");
  }
});
/*
|--------------------------------------------------------------------------
| Counties
|--------------------------------------------------------------------------
*/

app.get("/api/counties", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT DISTINCT county
      FROM locations
      ORDER BY county
    `);

    res.json(result.rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to load counties"
    });

  }

});
/*
|--------------------------------------------------------------------------
| Sub Counties
|--------------------------------------------------------------------------
*/

app.get(
  "/api/subcounties/:county",
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT DISTINCT sub_county
          FROM locations
          WHERE county = $1
          ORDER BY sub_county
          `,
          [req.params.county]
        );

      res.json(result.rows);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Failed to load sub counties"
      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| Wards
|--------------------------------------------------------------------------
*/

app.get(
  "/api/wards/:county/:subCounty",
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT ward
          FROM locations
          WHERE county = $1
          AND sub_county = $2
          ORDER BY ward
          `,
          [
            req.params.county,
            req.params.subCounty
          ]
        );

      res.json(result.rows);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Failed to load wards"
      });

    }

  }
);
/*
|--------------------------------------------------------------------------
| Submit Application
|--------------------------------------------------------------------------
*/

app.post("/apply", async (req, res) => {
console.log("🔥 APPLY ROUTE HIT");
  console.log("📦 BODY RECEIVED:", req.body);
  try {

    const {
      fullName,
      gender,
      dateOfBirth,
      email,
      phone,
      county,
      subCounty,
      ward,
      nextOfKin,
      courseName,
      studySession,
      referralSource
    } = req.body;

    /*
    ------------------------------------------------
    Course Prefix
    ------------------------------------------------
    */

    let courseCode = "GEN";

    if (courseName === "Computer Packages") {
      courseCode = "CP";
    }
    else if (courseName === "Agro Entrepreneurship") {
      courseCode = "AE";
    }
    else if (courseName === "Smartphone Literacy") {
      courseCode = "SL";
    }
    else if (courseName === "ICT") {
      courseCode = "ICT";
    }

    const year =
      new Date().getFullYear();

    /*
    ------------------------------------------------
    Generate Registration Number
    ------------------------------------------------
    */

    const countResult =
      await pool.query(
        `
        SELECT COUNT(*) AS total
        FROM applications
        WHERE course_name = $1
        `,
        [courseName]
      );

    const nextNumber =
      parseInt(
        countResult.rows[0].total
      ) + 1;

    const regNumber =
      `GD-${courseCode}-${String(nextNumber).padStart(4,"0")}-${year}`;

    /*
    ------------------------------------------------
    Save Application
    ------------------------------------------------
    */

    await pool.query(
      `
      INSERT INTO applications
      (
        reg_number,
        full_name,
        gender,
        date_of_birth,
        email,
        phone,
        county,
        sub_county,
        ward,
        next_of_kin,
        course_name,
        study_session,
        referral_source
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,$13
      )
      `,
      [
        regNumber,
        fullName,
        gender,
        dateOfBirth,
        email,
        phone,
        county,
        subCounty,
        ward,
        nextOfKin,
        courseName,
        studySession,
        referralSource || ""
      ]
    );
     /*
------------------------------------------------
Save Student Automatically
------------------------------------------------
*/

const existingStudent =
  await pool.query(
    `
    SELECT id
    FROM students
    WHERE reg_number = $1
    `,
    [regNumber]
  );

if (existingStudent.rows.length === 0) {

  await pool.query(
    `
    INSERT INTO students
    (
      student_name,
      reg_number,
      course_name
    )
    VALUES
    ($1,$2,$3)
    `,
    [
      fullName,
      regNumber,
      courseName
    ]
  );

}
    /*
    ------------------------------------------------
    Response
    ------------------------------------------------
    */

    res.json({

      success: true,

      regNumber,

      fullName,

      courseName,

      studySession

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});
/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 GDEH Exam Portal Running On Port ${PORT}`
    );

    console.log(
      `http://localhost:${PORT}`
    );

  }
);
