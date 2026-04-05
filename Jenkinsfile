/* groovylint-disable LineLength */
/*
  Jenkins declarative pipeline: verify client build, build Docker image, optional push.

  Required on the Jenkins agent:
  - Docker CLI (and daemon or Docker-in-Docker) for the "Docker build" stage.

  Optional CD (image push):
  - Credentials ID "docker-registry" (username/password) for your registry, OR set DOCKER_REGISTRY_CREDS_ID.
  - Environment (job or folder):
      DOCKER_REGISTRY   e.g. registry.example.com:5000/your-org
      IMAGE_NAME        image repository name (default: media-streaming)
  - Pushes only when BRANCH_NAME is "main" or "master" (adjust "when" below if needed).

  Optional overrides:
      SKIP_CLIENT_VERIFY = true   # skip npm ci + client build on agent (Dockerfile still builds inside image)
      SKIP_DOCKER_PUSH   = true   # never push
*/

pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timestamps()
    disableConcurrentBuilds(abortPrevious: true)
  }

  environment {
    DOCKER_BUILDKIT = '1'
    IMAGE_NAME = "${env.IMAGE_NAME ?: 'media-streaming'}"
    REGISTRY_PREFIX = "${env.DOCKER_REGISTRY ? env.DOCKER_REGISTRY + '/' : ''}"
    GIT_SHORT = "${env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : 'nogit'}"
    TAG = "${env.BRANCH_NAME ?: 'unknown'}-${env.BUILD_NUMBER}-${GIT_SHORT}"
    LOCAL_IMAGE = "${IMAGE_NAME}:${TAG}"
    REGISTRY_CREDS = "${env.DOCKER_REGISTRY_CREDS_ID ?: 'docker-registry'}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Verify client build') {
      when {
        expression { return env.SKIP_CLIENT_VERIFY != 'true' }
      }
      agent {
        docker {
          image 'node:20-bookworm-slim'
          reuseNode true
        }
      }
      steps {
        dir('client') {
          sh 'npm ci'
          sh 'npm run build'
        }
      }
    }

    stage('Docker build') {
      steps {
        script {
          sh "docker build -t ${LOCAL_IMAGE} ."
          sh "docker tag ${LOCAL_IMAGE} ${IMAGE_NAME}:latest"
        }
      }
    }

    stage('Docker push') {
      when {
        allOf {
          expression { env.SKIP_DOCKER_PUSH != 'true' }
          expression { env.DOCKER_REGISTRY?.trim() }
          anyOf {
            branch 'main'
            branch 'master'
          }
        }
      }
      steps {
        script {
          def remote = "${REGISTRY_PREFIX}${IMAGE_NAME}"
          sh "docker tag ${LOCAL_IMAGE} ${remote}:${TAG}"
          sh "docker tag ${LOCAL_IMAGE} ${remote}:latest"
          withCredentials([usernamePassword(
            credentialsId: REGISTRY_CREDS,
            usernameVariable: 'DOCKER_USER',
            passwordVariable: 'DOCKER_PASS',
          )]) {
            sh '''
              echo "$DOCKER_PASS" | docker login "$DOCKER_REGISTRY" -u "$DOCKER_USER" --password-stdin
            '''
          }
          sh "docker push ${remote}:${TAG}"
          sh "docker push ${remote}:latest"
        }
      }
    }
  }

  post {
    success {
      echo "Image: ${LOCAL_IMAGE} (also tagged ${IMAGE_NAME}:latest)"
    }
    cleanup {
      cleanWs()
    }
  }
}
